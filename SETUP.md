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

## Limitation: Instagram won't serve `media_url` for older posts

Instagram's Graph API only returns the `media_url` field (a direct, signed CDN link to the actual video/image file) for posts up to a certain age. Once a post ages past that window, the field comes back empty — silently, with no error — even though `permalink` (the public instagram.com link) still works fine. This is a limitation of Instagram's API itself, not something this app's code can work around by re-fetching or refreshing tokens.

If a workflow run fails with *"Instagram no longer provides a direct media link for this post"*, that post is too old for the API to hand over its file directly. To repost it anyway:

1. Find the post's `permalink` (shown in the dashboard, or in the error message) and manually download the video/image — a tool like [`yt-dlp`](https://github.com/yt-dlp/yt-dlp) handles Instagram URLs directly:
   ```
   yt-dlp "https://www.instagram.com/p/XXXXXXXXX/" -o "<ig_media_id>.mp4"
   ```
   Use `.jpg` instead of `.mp4` for image posts. The `<ig_media_id>` is the numeric ID from the dashboard/error message.
2. Move that file into `data/media/` inside this project, named exactly `<ig_media_id>.mp4` (or `.jpg`).
3. Stop the app, then point that post's `local_path` at the file you just added. The quickest way is a one-off Node script using the app's own DB module:
   ```js
   // save as e.g. fix-local-path.js in the project root, then run: node fix-local-path.js
   const db = require('./server/db');
   const path = require('path');
   (async () => {
     await db.init();
     const mediaId = '<ig_media_id>';
     const filePath = path.join(__dirname, 'data', 'media', `${mediaId}.mp4`); // or .jpg
     db.prepare(`UPDATE ig_media SET local_path = ? WHERE id = ?`).run(filePath, mediaId);
     console.log('Updated local_path for', mediaId);
   })();
   ```
4. Restart the app and re-run the workflow — since `local_path` now points to a real file on disk, the app skips Instagram entirely for that post and uses your manually-downloaded file.

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
