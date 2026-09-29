# Setup Guide — Historical Repost App

This app pulls your historical Instagram reels/posts (video + caption + hashtags) and reposts them to **YouTube Shorts** and/or **TikTok** via two configurable workflows.

You need three sets of API credentials: **Meta (Instagram)**, **Google Cloud (YouTube)**, and **TikTok for Developers**. Budget 30–60 minutes for first-time setup; TikTok approval can take longer if you want public (non-draft) auto-posting.

**Important — the app itself stays local.** This guide covers running the actual dashboard (fetching Instagram media, running workflows, scheduling) on your own machine only. It is not designed to run on Vercel or any other serverless host — it needs a persistent local database, downloaded video files on disk, and a long-running scheduler, none of which serverless functions provide. The one piece that *is* deployed to Vercel is the **Privacy Policy / Terms of Service pages** (section 4 below) — those are required by Meta/Google/TikTok's app review forms and need a stable public URL, which a local `http://localhost` link can't provide.

---

## 0. Prerequisites

- Node.js 18+ installed (the database layer uses `sql.js`, a WebAssembly build of SQLite, specifically so there's no native module to compile — this avoids `node-gyp`/build-tool failures on newer Node versions)
- An Instagram account converted to a **Business or Creator account**, linked to a **Facebook Page**
- A YouTube channel you own
- A TikTok account
- **[`yt-dlp`](https://github.com/yt-dlp/yt-dlp) installed and on your PATH** — required only for reposting Reels (see "Reels and yt-dlp" below); everything else works without it. Install with `pip install yt-dlp` (or see their install docs for other methods), then confirm it's on PATH by running `yt-dlp --version` in your terminal.

---

## 1. Instagram (Meta Graph API)

There are two separate Meta products that can read Instagram media, each with its **own OAuth endpoint and its own scope names** — mixing them up is the single most common setup error (it throws either "Invalid App ID" or "Invalid Scopes"). This app's code is built for **Option A: Facebook Login for Business**.

### Option A — Facebook Login for Business (what this app uses)

Reads a Page-linked Instagram Business/Creator account. Uses `facebook.com/v20.0/dialog/oauth`.

1. Go to [developers.facebook.com](https://developers.facebook.com) → **My Apps** → **Create App** → type "Other" → "Business".
2. In the app dashboard, **Add Product** → **Facebook Login for Business**.
3. Under **App Settings → Basic**, copy the **App ID** and **App Secret** into `.env` as `IG_APP_ID` / `IG_APP_SECRET`.
4. Under **Facebook Login for Business → Settings**, add this **Valid OAuth Redirect URI**:
   `http://localhost:3011/auth/instagram/callback`
5. Make sure your Facebook Page is linked to your Instagram Business/Creator account (Instagram app → Settings → Account → Linked Accounts → Facebook).
6. Add yourself under **App roles → Roles** as an Admin/Developer so you can authorize without a full App Review (fine for personal/single-account use).
7. The scopes this app requests are: `instagram_basic`, `pages_show_list`, `pages_read_engagement`, `pages_read_user_content`, `business_management`. **`instagram_basic` is correct and current here** — it is *not* deprecated; only the unrelated Instagram Basic Display API (a different, now-shut-down product) used a similarly-named permission. Do not substitute `instagram_business_basic` in this flow — that name belongs to the other product below and Meta will reject it with "Invalid Scopes."

### Option B (different product, not what this app is coded for) — Instagram API with Instagram Login

A newer product that skips the Facebook Page requirement, but uses a **different OAuth endpoint** (`instagram.com/oauth/authorize`) and **different scope names** (`instagram_business_basic`, `instagram_business_content_publish`). This app's OAuth code targets Option A above, not this product — only use this path if you're willing to adapt `server/services/instagram.js`'s `authUrl()`/`exchangeCodeForToken()` to Instagram's own login endpoint instead of Facebook's.

### Option C — shortcut: paste a token directly (skip OAuth entirely)

The fastest way to get running: in **Graph API Explorer** (developers.facebook.com/tools/explorer), select your app, generate a **Page token** with `instagram_basic` + `pages_show_list` + `pages_read_engagement` permissions, exchange it for a long-lived token (Explorer has a button for this, ~60 day expiry), and find your **Instagram Business Account ID** via `/me/accounts?fields=instagram_business_account`. Paste both into `.env`:

```
IG_ACCESS_TOKEN=your-long-lived-token
IG_BUSINESS_ACCOUNT_ID=your-ig-business-account-id
```

The app uses these directly and skips the `/auth/instagram` OAuth flow — no redirect URI setup needed at all. You'll need to refresh the token roughly every 60 days.

---

## 2. YouTube (Google Cloud)

1. Go to [console.cloud.google.com](https://console.cloud.google.com) → create a new project.
2. **APIs & Services → Library** → enable **YouTube Data API v3**.
3. **APIs & Services → OAuth consent screen**: choose "External", fill required fields, add your Google account as a **Test user** (keeps the app unpublished/no Google review needed for personal use).
4. **APIs & Services → Credentials → Create Credentials → OAuth client ID** → Application type: **Web application**.
5. Add this Authorized redirect URI:
   `http://localhost:3011/auth/youtube/callback`
6. Copy the **Client ID** and **Client Secret** into `.env` as `YT_CLIENT_ID` / `YT_CLIENT_SECRET`.
7. Note: as of mid-2026, Google moved video uploads to their own dedicated quota bucket (~100 uploads/day, separate from the general 10,000 units/day pool used for other API calls), so daily upload volume is no longer the bottleneck it once was. Request a quota increase from Google if you need more than 100 uploads/day.

---

## 3. Deploy the legal + TikTok relay site (Vercel) — do this before configuring TikTok

TikTok's Login Kit **rejects `localhost` redirect URIs outright**, even over https — it requires a real, publicly resolvable domain. Meta and Google's app review forms also want a **Privacy Policy URL** and **Terms of Service URL** that their crawlers can load without logging in, which a local server can't provide either. The `legal/` folder in this project is a small static site that solves both: it hosts the Privacy Policy, Terms of Service, and a TikTok OAuth relay page, ready to deploy as-is.

1. Install the Vercel CLI once, if you don't have it: `npm install -g vercel`
2. From the project root:
   ```bash
   cd repost-app/legal
   vercel
   ```
3. Follow the prompts (log in with a free Vercel account if needed, accept the defaults — it auto-detects this as a static site since there's no framework config). Vercel gives you a URL like `https://your-project-name.vercel.app`.
4. Promote it to production so the URL is stable: `vercel --prod`
5. Your URLs are now:
   - Privacy Policy: `https://your-project-name.vercel.app/privacy`
   - Terms of Service: `https://your-project-name.vercel.app/terms`
   - Web/Desktop URL (for TikTok's app config): `https://your-project-name.vercel.app`
   - TikTok OAuth relay: `https://your-project-name.vercel.app/tiktok-callback`
   (the clean `/privacy`, `/terms`, `/tiktok-callback` paths are already configured in `legal/vercel.json`)
6. If you'd rather use the dashboard instead of the CLI: go to [vercel.com/new](https://vercel.com/new), import this project from a Git repo (push the `repost-app` folder to GitHub/GitLab first), and set the **Root Directory** to `legal` in the import settings before deploying.
7. To update the pages later (e.g. after editing `legal/privacy.html`), just re-run `vercel --prod` from inside `legal/` — same URL, new content.
8. Meta, Google, and TikTok's app review forms may also ask you to **verify** these URLs (a separate step from just entering them) — this proves you own the domain. Each platform offers either a DNS TXT record method (not usable on a free `*.vercel.app` subdomain you don't control DNS for) or a **URL-prefix/file method**: it gives you a signature file to download, which you drop into `legal/` at the exact filename it specifies, then redeploy (`vercel --prod`) before clicking Verify. Use the file method, not DNS, for a `*.vercel.app` URL.

**Only the `legal/` folder goes to Vercel.** The rest of the app (the dashboard, Instagram/YouTube/TikTok integrations, scheduler) is designed to run locally per section 5 below — it depends on a persistent local database and downloaded video files that a serverless host like Vercel doesn't provide.

---

## 4. TikTok (TikTok for Developers)

1. Go to [developers.tiktok.com](https://developers.tiktok.com) → **Manage Apps** → **Create an app**.
2. Add the **Login Kit** and **Content Posting API** products.
3. Under Login Kit's Redirect URI settings, add the relay URL from section 3:
   `https://your-project-name.vercel.app/tiktok-callback`
4. Copy the **Client Key** and **Client Secret** into `.env` as `TT_CLIENT_KEY` / `TT_CLIENT_SECRET`, and set `TT_REDIRECT_URI=https://your-project-name.vercel.app/tiktok-callback`.
5. **Important — audit status:** new/unaudited TikTok apps can only post videos as **private (SELF_ONLY / draft)**, capped around 15 posts/day/creator — TikTok requires app review before you can auto-publish as public. This app automatically detects that restriction and falls back to draft posting; you'll then need to open TikTok and manually publish drafted videos until your app passes review.
6. To apply for full posting: in the developer portal, submit your app for **Content Posting API audit**, providing a demo video of the complete end-to-end flow (Instagram connect → fetch media → TikTok connect → post).
7. **How connecting TikTok works in this app:** click **Connect** for TikTok in the dashboard — this opens TikTok's consent screen, and after you approve, TikTok redirects to your **Vercel relay page** (not back to your local server, since TikTok won't redirect to localhost). That page displays an authorization code on screen. Copy it, go back to your local dashboard, paste it into the **"Complete TikTok connection"** field under TikTok in the Connections panel, and click **Complete**. This one extra manual step only happens when (re)connecting TikTok — regular posting afterward is fully automatic.

---

## 5. Install & run

```bash
cd repost-app
npm install
cp .env.example .env
# edit .env with the credentials from steps 1, 2, 3, and 4
npm start
```

Open **http://localhost:3011**.

1. Click **Connect** for Instagram, YouTube, and TikTok (each opens that platform's OAuth consent screen). For TikTok specifically, see the "How connecting TikTok works" note at the end of section 4 — it involves one extra copy/paste step via the Vercel relay page.
2. Click **Fetch from Instagram** to pull your historical reels/posts into the dashboard.
3. Create a workflow: name it, pick a target (YouTube or TikTok), set posts-per-run, and optionally a cron schedule (e.g. `0 9 * * *` = daily at 9am).
4. Click **Run now** to repost the next un-posted items, or check specific rows and click **Run selected**.
5. Watch the **Activity Log** for success/failure/draft status and resulting links.

---

## How captions/tags are mapped

- **YouTube**: title = first line of IG caption (hashtags stripped), description = full caption + hashtags + `#Shorts`, tags = hashtags without `#`.
- **TikTok**: caption = full IG caption with hashtags inline (TikTok has no separate tags field).
- The app tracks what's already been posted per platform (`post_log` table) so re-running a workflow never double-posts the same reel.

## Data storage

All data lives locally in `data/app.db` (SQLite) and `data/media/` (downloaded video files) — nothing leaves your machine except the direct API calls to Meta, Google, and TikTok.

## Reels and yt-dlp

Confirmed directly against Instagram's API (by logging its raw response): for any post where `media_product_type` is `REELS`, the Graph API returns no `media_url` at all — not because the post is old, not because of a permissions gap, but because Instagram simply never populates that field for Reels via this API, at any age. `permalink` (the public instagram.com/reel/... link) still works fine; only the direct downloadable file link is withheld through the official API. There is no supported Graph API field or endpoint that returns Reel video bytes.

To work around this, the app automatically falls back to [`yt-dlp`](https://github.com/yt-dlp/yt-dlp) whenever it needs to download a Reel's video (for reposting to YouTube, or to TikTok as a video post) — it shells out to `yt-dlp <permalink> -o data/media/<id>.mp4`, then continues exactly as it would with an Instagram-provided download. **Important distinction:** this reads from Instagram's public web page, not the official Graph API — a different trust boundary than the rest of the app, which otherwise only talks to Meta's, Google's, and TikTok's official APIs. It's your own content and a common, low-risk pattern for personal tools, but it isn't sanctioned by Instagram's Terms of Service the way the Graph API calls are, and could in principle break if Instagram changes its page structure (yt-dlp is actively maintained specifically to keep up with such changes).

### Installing yt-dlp (project-local venv, recommended)

The app looks for yt-dlp inside a project-local Python virtual environment first (`.venv/bin/yt-dlp` on macOS/Linux, `.venv\Scripts\yt-dlp.exe` on Windows), before falling back to a global `yt-dlp` on PATH. This keeps the dependency isolated from the rest of your system instead of requiring a global pip install. Set it up once, from this project's root folder:

```
python3 -m venv .venv
```

Then install yt-dlp into it:

- **macOS/Linux:** `.venv/bin/pip install yt-dlp`
- **Windows (Command Prompt):** `.venv\Scripts\pip install yt-dlp`
- **Windows (PowerShell):** `.venv\Scripts\pip.exe install yt-dlp`

Verify it worked:

- **macOS/Linux:** `.venv/bin/yt-dlp --version`
- **Windows:** `.venv\Scripts\yt-dlp.exe --version`

No further configuration needed — the app detects `.venv` automatically and uses it. Add `.venv/` to your `.gitignore` if this project is under version control, since it's a local, machine-specific folder that shouldn't be committed.

**Alternative — global install (simpler, less isolated):** skip the venv and just run `pip install yt-dlp` (or `pipx install yt-dlp`) so `yt-dlp` is on your system PATH. The app falls back to this automatically if no `.venv` is found.

If yt-dlp is missing entirely, or a download otherwise fails, the workflow fails that post with a clear message rather than silently skipping — check the message for the exact yt-dlp error.

The dashboard flags Reels with a ⚠️ next to "Reels" in the Type column, purely as an indicator that this fallback path will be used for them.

TikTok photo posting is the one path that still can't support Reels even with this fallback — TikTok's photo API needs a live remote URL it fetches itself (`PULL_FROM_URL`), not a local file, and Reels are always videos anyway, so this doesn't come up in practice.

If you'd rather not install yt-dlp, or want to handle a specific Reel by hand instead, you can still do it manually:

1. Download the video yourself (e.g. `yt-dlp "https://www.instagram.com/reel/XXXXXXXXX/" -o "<ig_media_id>.mp4"`, or any other method).
2. Move that file into `data/media/` inside this project, named exactly `<ig_media_id>.mp4`.
3. Stop the app, then point that post's `local_path` at the file you just added. The quickest way is a one-off Node script using the app's own DB module:
   ```js
   // save as e.g. fix-local-path.js in the project root, then run: node fix-local-path.js
   const db = require('./server/db');
   const path = require('path');
   (async () => {
     await db.init();
     const mediaId = '<ig_media_id>';
     const filePath = path.join(__dirname, 'data', 'media', `${mediaId}.mp4`);
     db.prepare(`UPDATE ig_media SET local_path = ? WHERE id = ?`).run(filePath, mediaId);
     console.log('Updated local_path for', mediaId);
   })();
   ```
4. Restart the app and re-run the workflow — since `local_path` now points to a real file on disk, the app skips straight to using it.

(A small number of very old non-Reel posts can separately return an empty `media_url` too — Instagram doesn't document a fixed cutoff for this, but it's rare and shows a different message pointing at possible deletion/archiving; the manual steps above work for those too.)

## Scheduling: built-in vs. OS-level (and why this can't move to Vercel)

The dashboard's own cron field (e.g. `0 9 * * *`) is handled by `node-cron`, which works by keeping a timer running inside the app's Node process — it only fires while `npm start` is actively running. This means:

- **This can't run on Vercel or similar serverless hosts.** Serverless functions spin up per request and shut down between them — there's no long-lived process for `node-cron`'s timer to live in, so a schedule would simply never fire. The same hosts also can't persist the local SQLite database or downloaded video files between invocations, and video uploads often exceed serverless execution time limits. (This is exactly why only the static `legal/` folder — Privacy Policy, Terms, and the TikTok relay page — is deployed to Vercel elsewhere in this guide; the actual dashboard and its scheduler are designed to run locally.)
- **A sleeping or restarted computer also stops it** — if your machine sleeps through a scheduled time, or the app isn't running, that run is simply skipped (it does not "catch up" retroactively).

For a more resilient alternative or supplement, you can use your operating system's own scheduler to call the app's API directly over HTTP — this survives your machine waking up late (most OS schedulers run a missed job shortly after wake) in a way an in-process JS timer does not, though it still requires the computer to be on and the app running at the scheduled time; none of this removes the fundamental need for a running process, since there is no way to reach a stopped local server.

**Find your workflow's ID** first — open `http://localhost:3011/api/workflows` in a browser or `curl http://localhost:3011/api/workflows` in a terminal, and note the `id` field of the workflow you want to schedule.

**macOS / Linux — cron:**
```bash
crontab -e
```
Add a line (runs daily at 9am; replace `3` with your workflow's actual id):
```
0 9 * * * curl -s -X POST http://localhost:3011/api/workflows/3/run -H "Content-Type: application/json" -d "{}"
```

**Windows — Task Scheduler:**
1. Open Task Scheduler → **Create Basic Task** → set your trigger (e.g. Daily, 9:00 AM).
2. Action: **Start a program** → Program/script: `curl.exe` → Arguments:
   ```
   -s -X POST http://localhost:3011/api/workflows/3/run -H "Content-Type: application/json" -d "{}"
   ```
   (`curl.exe` ships with Windows 10/11 by default; if missing, install it or use `Invoke-WebRequest` in a `.ps1` script instead.)

Either approach calls the exact same endpoint the dashboard's "Run now" button uses, so behavior (dedup checks, YouTube duplicate detection, TikTok draft fallback, activity logging) is identical — this only changes what triggers the call.
