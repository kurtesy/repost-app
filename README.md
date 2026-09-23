# Historical Repost Tool

A local web app that takes your own historical Instagram Reels/posts and reposts them — same video, same caption, same hashtags — to your own YouTube Shorts and TikTok accounts.

It's a self-hosted alternative to services like Repurpose.io or OneUp: you run it on your own machine, connect your own accounts, and nothing goes through a third-party server.

## What it does

- **Pulls your historical Instagram media** via the Instagram Graph API — video files, captions, and hashtags from your own Business/Creator account.
- **Two independent workflows** you configure yourself: e.g. "IG → YouTube" and "IG → TikTok". Each has its own target platform, posting cadence, and privacy setting.
- **Maps captions automatically per platform**:
  - YouTube: title (first line of caption, hashtags stripped), description (full caption + hashtags + `#Shorts`), tags (hashtags without `#`)
  - TikTok: full caption with hashtags inline
- **Posts via each platform's official API** — YouTube Data API v3, TikTok Content Posting API — with OAuth you authorize once from the dashboard.
- **Never double-posts** — every repost is logged locally, so re-running a workflow only picks up items not yet sent to that platform.
- **Manual or scheduled** — click "Run now" / "Run selected" anytime, or set an optional cron schedule per workflow (e.g. daily at 9am).
- **Runs entirely locally** — SQLite database (via `sql.js`, no native build step) and downloaded video files live in a local `data/` folder. The only network calls are directly to Meta, Google, and TikTok's own APIs, authenticated as you.

## What it's not

- Not a hosted or multi-user service — it's built for one operator running it on their own machine against their own accounts.
- Not a way around each platform's own posting rules — TikTok's unaudited-app restriction (posts land as private/draft until your app passes their review) still applies, and the tool surfaces that status rather than hiding it.
- Not a content editor — it reposts the same video/caption/tags as-is; it doesn't trim, re-encode, or rewrite anything.

## Project layout

```
repost-app/
├── server/
│   ├── index.js              # Express app entry point (HTTP + optional local HTTPS for TikTok)
│   ├── db/                   # sql.js-backed storage: tokens, media, workflows, post log
│   ├── services/
│   │   ├── instagram.js      # Instagram Graph API: OAuth, fetch media, download video
│   │   ├── youtube.js        # YouTube Data API v3: OAuth, upload as Short
│   │   ├── tiktok.js         # TikTok Content Posting API: OAuth, upload (with draft fallback)
│   │   ├── caption.js        # Caption/hashtag parsing + per-platform formatting
│   │   ├── workflow.js       # Ties it together: run a workflow, dedupe, log results
│   │   └── scheduler.js      # node-cron wiring for scheduled workflows
│   └── routes/               # auth.js (OAuth callbacks), api.js (dashboard API)
├── public/index.html         # Single-page dashboard UI
├── data/                     # Local SQLite DB + downloaded media (created at runtime)
├── certs/                    # Optional local HTTPS cert (unused by TikTok — see note below)
├── .env.example               # Credential template
├── SETUP.md                   # Step-by-step: Meta App, Google Cloud project, TikTok app, Vercel deploy
├── privacy-policy.html        # Required by Meta/Google/TikTok app review
└── terms-of-service.html      # Required by Meta/Google/TikTok app review
```

## Getting started

1. Follow **[SETUP.md](./SETUP.md)** to create the three developer credentials (Meta, Google Cloud, TikTok) and generate a local HTTPS cert for TikTok.
2. Copy `.env.example` to `.env` and fill in the values from step 1.
3. ```bash
   npm install
   npm start
   ```
4. Open `http://localhost:3011`, connect each platform, fetch your Instagram history, and create a workflow.

## How reposting stays safe

- Every post to YouTube or TikTok is recorded in a local `post_log` table keyed by Instagram media ID + target platform, so a workflow run (manual or scheduled) skips anything already posted there.
- TikTok posting attempts your requested privacy level first and automatically falls back to `SELF_ONLY` (private/draft) if your app hasn't passed TikTok's Content Posting API audit yet — you'll see that status in the Activity Log and need to publish those drafts manually from the TikTok app until the audit clears.
- Access tokens are stored locally in the SQLite database, not in this repo or any external service.
