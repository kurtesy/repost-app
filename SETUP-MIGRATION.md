# Deploying repost-app to the world (Vercel + Neon + your VPS)

This covers moving repost-app from "runs on my laptop" to a real hosted deployment at
`repost-app.thetwopisceans.com`, backed by Neon Postgres, with Instagram Reels downloads handled
by a separate always-on helper service on your own VPS. Do this after `SETUP.md`'s local setup —
this document assumes the app already works locally.

Architecture recap: the dashboard + API run as a single Vercel serverless function (wrapping the
existing Express app). Scheduling runs via Vercel Cron hitting `/api/cron/tick` once a day
(Hobby plan limit — see "Scheduling limitations" below). The database is Neon Postgres. Reels,
which Instagram's API never exposes a direct media URL for, are downloaded by yt-dlp running on
your own VPS (`ytdlp-helper/`, deployed separately — see `ytdlp-helper/DEPLOY.md`), which uploads
the result to Vercel Blob for the main app to fetch.

---

## 1. Create the Neon database

1. Go to [neon.com](https://neon.com), create an account/project (the Free plan is fine to start).
2. In the project dashboard, copy the **connection string** (it looks like
   `postgresql://user:password@ep-xxxx.region.aws.neon.tech/dbname?sslmode=require`).
3. Save it — this is your `DATABASE_URL`.

Nothing else to do here manually: the app creates its own tables and runs migrations automatically
on first request (`server/db/index.js`'s `init()`, invoked via `ensureDbReady()`).

## 2. Create the Vercel project

1. Push this repo to GitHub/GitLab/Bitbucket if it isn't already (Vercel deploys from a git repo).
   **Important:** make sure `ytdlp-helper/` is committed too if you want it in the same repo for
   convenience — it is a separate deployable, but there's no harm keeping it in the same git repo;
   Vercel only looks at the root `vercel.json`/`api/` when building this project.
2. In the [Vercel dashboard](https://vercel.com/dashboard), **Add New → Project**, import that repo.
3. Framework preset: leave as "Other" — this app isn't Next.js/etc, it's a plain `vercel.json` +
   `api/index.js` setup already committed to the repo.
4. Don't deploy yet — set environment variables first (next section), or the first deploy will
   fail fast on the missing `DASHBOARD_PASSWORD` check.

### Vercel Blob store

While in the project: **Storage → Create Database → Blob**. This is used both by the main app
(implicitly, since it just fetches whatever public URL the helper hands back) and directly by the
`ytdlp-helper` service, which needs its own copy of the resulting `BLOB_READ_WRITE_TOKEN` (see
`ytdlp-helper/DEPLOY.md` step 4 — same store, token copied to both places).

## 3. Set Vercel environment variables

In the project's **Settings → Environment Variables**, add (Production, and Preview if you want
preview deployments to work too):

| Variable | Value |
|---|---|
| `DASHBOARD_PASSWORD` | A password you'll type in to access the dashboard. Pick something long — this is the only thing standing between the public internet and your connected accounts. |
| `SESSION_SECRET` | Random long string: `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"` |
| `DATABASE_URL` | From step 1 (Neon connection string). |
| `CRON_SECRET` | Random long string (same command as above). Vercel Cron sends this automatically as `Authorization: Bearer $CRON_SECRET` once the env var is set — no extra config needed, but **verify this against Vercel's current Cron docs before relying on it**, since this convention was implemented based on documented behavior at the time this app was built and platform details can change. |
| `YTDLP_HELPER_URL` | `https://ytdlp-helper.thetwopisceans.com/download` (or wherever you deploy it — see step 6) |
| `YTDLP_HELPER_SECRET` | Random long string. Must exactly match `HELPER_SECRET` in the VPS helper's own `.env` (see `ytdlp-helper/DEPLOY.md` step 5). |
| `IG_APP_ID`, `IG_APP_SECRET` | Same values as local `.env`. |
| `IG_REDIRECT_URI` | `https://repost-app.thetwopisceans.com/auth/instagram/callback` |
| `YT_CLIENT_ID`, `YT_CLIENT_SECRET` | Same values as local `.env`. |
| `YT_REDIRECT_URI` | `https://repost-app.thetwopisceans.com/auth/youtube/callback` |
| `TT_CLIENT_KEY`, `TT_CLIENT_SECRET` | Same values as local `.env`. |
| `TT_REDIRECT_URI` | `https://repost-app.thetwopisceans.com/auth/tiktok/callback` — points directly at this app's own callback route, exactly like `IG_REDIRECT_URI`/`YT_REDIRECT_URI` above. TikTok's Login Kit used to reject direct callbacks like this because it rejects `localhost` redirect URIs and this app previously had no real public domain — hence the old relay-page + manual-paste workaround. Now that this app is hosted on a real HTTPS domain, that workaround isn't needed: `/auth/tiktok/callback` completes the connection automatically, same as the other two platforms. The old relay page (`public/legal/tiktok-callback.html`) and manual-paste flow (`POST /auth/tiktok/complete`) are kept as a fallback, reachable via "Trouble connecting?" on the dashboard, but are no longer the primary path. |

Do **not** set `IG_ACCESS_TOKEN`/`IG_BUSINESS_ACCOUNT_ID` unless you're intentionally skipping
Instagram OAuth with a pasted long-lived token, same as local.

## 4. Update OAuth redirect URIs in each platform's developer console

The redirect URIs above must also be registered on the provider's side, or the OAuth flow will
reject the callback with a redirect-URI-mismatch error:

- **Meta (Instagram):** [developers.facebook.com](https://developers.facebook.com) → your app →
  Facebook Login for Business (or Instagram API with Instagram Login) → Settings → add
  `https://repost-app.thetwopisceans.com/auth/instagram/callback` to the valid OAuth redirect URIs.
- **Google (YouTube):** [console.cloud.google.com](https://console.cloud.google.com) → APIs &
  Services → Credentials → your OAuth client → add
  `https://repost-app.thetwopisceans.com/auth/youtube/callback` to Authorized redirect URIs.
- **TikTok:** [developers.tiktok.com](https://developers.tiktok.com) → your app → Login Kit →
  update the Redirect URI to `https://repost-app.thetwopisceans.com/auth/tiktok/callback` (see
  the `TT_REDIRECT_URI` row above — this must match exactly, or TikTok rejects the OAuth flow).
  Also confirm the app's **Privacy Policy URL** and **Terms of Service URL** fields in the same
  developer console point at `https://repost-app.thetwopisceans.com/privacy` and `/terms` — these
  were likely still set to the old `repost-tool.vercel.app` URLs.

You can keep the old `localhost` redirect URIs registered alongside the new ones on all three —
local dev will keep working.

### Retiring the old separate "repost-tool" Vercel project

The Privacy Policy, Terms of Service, TikTok relay page, and TikTok domain-verification file used
to be hosted as their own, separate Vercel project (folder `legal/` in this repo, deployed under
its own project name — commonly seen as `repost-tool.vercel.app`). They've been folded into this
same app: the files now live at `public/legal/`, served via clean URLs (`/privacy`, `/terms`,
`/tiktok-callback`) wired up in `server/app.js`, and explicitly kept public (no dashboard password
required) in `server/middleware/auth.js`'s `PUBLIC_PATHS` — the same reasoning as the OAuth
callback routes above: these are hit by automated crawlers and TikTok's own redirect, not by an
authenticated dashboard session.

Once you've confirmed `/privacy`, `/terms`, and `/tiktok-callback` all load correctly on this
app's new domain (see the verification checklist below) and have updated TikTok's redirect URI to
match, the old separate Vercel project is no longer needed:

1. In the [Vercel dashboard](https://vercel.com/dashboard), open the old project (the one linked
   to the `legal/` folder — check `legal/.vercel/project.json` locally if you're unsure which one).
2. **Settings → Advanced → Delete Project** (or simply stop deploying to it and let it sit unused
   — deleting is cleaner but not urgent, since nothing points at it anymore once the TikTok
   redirect URI is updated).
3. The `legal/` folder itself can be deleted from this repo once you've confirmed the migrated
   copies under `public/legal/` are working — it's no longer deployed anywhere and is now dead
   weight in the repo, not a live dependency.

Do this only AFTER confirming the new `/tiktok-callback` URL works and TikTok's console has been
updated — deleting the old project first would break TikTok reconnects until the redirect URI
change propagates.

## 5. Add the custom domain

1. In the Vercel project: **Settings → Domains → Add** → `repost-app.thetwopisceans.com`.
2. Vercel will show you a DNS record to add — normally a `CNAME` pointing `repost-app` to
   `cname.vercel-dns.com` (Vercel shows the exact value; use that, not this placeholder, since it
   can vary).
3. At your domain registrar/DNS provider for `thetwopisceans.com`, add that CNAME record for the
   `repost-app` subdomain.
4. Wait for DNS propagation (usually minutes, sometimes longer) and for Vercel to confirm the
   domain and auto-provision its TLS certificate.

## 6. Deploy the yt-dlp helper to your VPS

This is a separate service from the Vercel deployment — follow **`ytdlp-helper/DEPLOY.md`** in
full (systemd/PM2 setup, yt-dlp venv, nginx + Let's Encrypt for HTTPS, and wiring its
`HELPER_SECRET` to match `YTDLP_HELPER_SECRET` above). Do this before or after the Vercel deploy;
order doesn't matter, but Reels reposting won't work until both sides are up and pointed at each
other correctly.

## 7. Deploy

Trigger the deploy (push to the branch Vercel is watching, or **Deployments → Redeploy** in the
dashboard). Watch the build logs; if `DASHBOARD_PASSWORD` or `DATABASE_URL` are missing, the very
first request will 500 with a clear error message rather than silently serving unprotected.

## 8. Verify before relying on it

Work through this checklist against the live `https://repost-app.thetwopisceans.com`:

- [ ] Visiting `/` redirects to `/login.html` if not signed in, and the dashboard never renders
      without a valid session (confirms the auth gate is actually active in production — see the
      "Static file gap" note below for why this specifically needs checking).
- [ ] Signing in with `DASHBOARD_PASSWORD` works and lands back on `/`.
- [ ] `/api/media`, `/api/workflows`, `/api/log` all return data once signed in, and 401 in an
      incognito window (not signed in).
- [ ] Connect/reconnect each of Instagram, YouTube, and TikTok from the live dashboard — the OAuth
      redirect round-trip is the part most likely to break under a new domain.
- [ ] `/privacy`, `/terms`, and `/tiktok-callback` all load without signing in first (open them in
      an incognito window) — these must stay public for app review crawlers and TikTok's OAuth
      redirect to work; confirms the `PUBLIC_PATHS` entries added when the old separate
      "repost-tool" legal site was folded into this app are working correctly.
- [ ] Fetch some historical media, confirm it lists correctly.
- [ ] Run a workflow manually ("Run now") against a non-Reel post and confirm it posts and shows
      up in the Activity Log.
- [ ] Run a workflow manually against a Reel and confirm the yt-dlp helper round-trip works
      (check `journalctl -u ytdlp-helper -f` or `pm2 logs ytdlp-helper` on the VPS while doing this
      — the fastest way to see if the helper is even being reached).
- [ ] Manually trigger the cron tick once to confirm it works end-to-end before trusting the daily
      schedule:
      ```
      curl -H "Authorization: Bearer YOUR_CRON_SECRET" https://repost-app.thetwopisceans.com/api/cron/tick
      ```
      Should return a JSON summary of which workflows were due and their outcomes.

### Note: the static-file auth gap that was fixed here

An earlier version of `vercel.json` only rewrote `/auth/*` and `/api/*` to the serverless
function, relying on Vercel's automatic static-file serving for everything else (`public/`). That
would have let anyone load the dashboard's HTML/JS directly from Vercel's CDN, bypassing
`requireAuth` entirely, even with `DASHBOARD_PASSWORD` set (API calls would still have 401'd, but
the dashboard page itself, and any post metadata baked into its initial HTML, would have been
publicly viewable). `vercel.json` now rewrites every path to the function, so `requireAuth` runs
on literally every request, matching local dev's behavior exactly. If you ever change
`vercel.json`, keep this in mind — a catch-all rewrite to `/api` is required for the auth gate to
mean anything on Vercel.

## Scheduling limitations (Vercel Hobby plan)

Hobby-tier Vercel Cron only fires **once per day**, at whatever fixed UTC time you set in
`vercel.json`'s `crons` entry (currently `0 9 * * *` = 9am UTC — change the schedule string there
and redeploy if you'd prefer a different time). `server/routes/cron.js` works around this: any
workflow whose own schedule implies "at least daily" (hourly, every-N-hours, daily-at-a-time) runs
every time this single daily tick fires; a genuinely less-than-daily schedule (weekly, monthly)
only runs if it was actually due within roughly the last 24-27 hours. The accepted tradeoff: an
hourly-configured workflow now effectively runs once a day, at the fixed cron time, not hourly.
Upgrading to Vercel Pro ($20/mo) would allow an arbitrary-interval cron schedule instead, if that
degradation becomes a problem later.

## Updating the app later

Push to the branch Vercel is watching — deploys automatically on every push (or manually via
**Deployments → Redeploy**). Database migrations in `server/db/index.js`'s `runMigrations()` run
automatically on the first request after a deploy that includes new ones (no separate migration
step to run by hand). The `ytdlp-helper` service on your VPS is deployed independently — see
`ytdlp-helper/DEPLOY.md`'s "Updating later" section.

## Known rough edges to keep an eye on

These were flagged during development as needing real-world confirmation rather than pure
documentation reading, since exact platform behavior can shift:

- **Vercel Cron's auth header.** `server/routes/cron.js` assumes Vercel sends
  `Authorization: Bearer $CRON_SECRET` automatically once `CRON_SECRET` is set as an env var. If
  the manual `curl` test in the verification checklist above works but the actual daily cron never
  seems to fire workflows, check Vercel's current Cron documentation for the exact header/auth
  convention and adjust `verifyCronRequest()` in `server/routes/cron.js` if it's changed.
- **In-memory double-run guard doesn't persist across cold starts.** `workflow.js`'s
  `runningWorkflows` Set only protects against double-triggering within a single warm
  container/invocation, not across separate serverless invocations. A genuine double-post would
  require two triggers (e.g. cron + a simultaneous manual "Run now") landing in different
  containers at almost the exact same moment — a narrow, accepted risk rather than something
  worth a DB-backed lock for a personal tool at this scale.
- **`scripts/backfill-reel-downloads.js` and `fix-local-path.js` are stale.** Both were built
  around the old local-disk `data/media/` caching model and direct `spawn('yt-dlp', ...)` calls,
  neither of which exist anymore (media is now always re-downloaded per-request into
  `os.tmpdir()`, and Reels go through the VPS helper). They're left in place but unused — safe to
  ignore, or delete if you want to tidy up.
