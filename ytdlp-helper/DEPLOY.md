# Deploying the yt-dlp helper to your VPS

This is a separate, standalone Node service from the main repost-app. It exists purely because
Vercel's serverless functions can't run yt-dlp; this service does, on your own always-on
Ubuntu/Debian VPS.

## Local development (no VPS, no Vercel Blob needed)

To test Reels reposting on your local machine (main app running via `npm run dev` / `npm start`,
not deployed to Vercel), you don't need a VPS or a real Vercel Blob store — run this service
locally alongside the main app:

```
cd ytdlp-helper
npm install
python3 -m venv .venv && .venv/bin/pip install yt-dlp   # see step 3 below for details
cp .env.example .env
```

Edit `.env` and set only `HELPER_SECRET` (any string for local testing) — **leave
`BLOB_READ_WRITE_TOKEN` blank**. With no Blob token set, this service automatically switches to
serving downloaded files itself instead of uploading them to Vercel Blob (you'll see a
`LOCAL-SERVE mode` warning in its startup log confirming this). Then:

```
npm start
```

In the main repost-app's own `.env` (project root, not this folder), set:

```
YTDLP_HELPER_URL=http://localhost:8088/download
YTDLP_HELPER_SECRET=<same value as HELPER_SECRET above>
```

Restart the main app, then try reposting a Reel — it should now download successfully through
the locally-running helper instead of failing with "YTDLP_HELPER_URL is not set."

This local-serve mode is deliberately unauthenticated on its file-serving route and has no
cleanup — it's meant only for this same-machine local-dev setup, never for a real deployment. The
sections below (a real VPS, with real Vercel Blob storage) are what to follow once you're ready
to deploy for real — see `SETUP-MIGRATION.md` in the project root for the full picture of how this
fits into the rest of the hosted deployment.

## 1. Copy this folder to the VPS

From your local machine:

```
scp -r ytdlp-helper your-user@your-vps-ip:/home/your-user/ytdlp-helper
```

Or `git clone`/`git pull` it there if you're tracking this repo in git and cloned it on the VPS
directly (in that case just make sure `ytdlp-helper/` is included — don't put it in `.gitignore`).

## 2. Install Node dependencies

```
cd /home/your-user/ytdlp-helper
npm install
```

Requires Node.js 18+. Check with `node -v`; if it's missing or too old, install via
[NodeSource](https://github.com/nodesource/distributions) or `nvm`.

## 3. Install yt-dlp into a project-local venv

Same approach as the main app's SETUP.md — an isolated virtualenv instead of a global pip install:

```
sudo apt-get update && sudo apt-get install -y python3-venv
python3 -m venv .venv
.venv/bin/pip install --upgrade pip
.venv/bin/pip install yt-dlp
.venv/bin/yt-dlp --version
```

Also install `ffmpeg`, which yt-dlp needs for some Instagram formats:

```
sudo apt-get install -y ffmpeg
```

## 4. Create a Vercel Blob store and get its token

1. In the Vercel dashboard, open the same project you're deploying the main repost-app to (or any
   project — Blob stores aren't tied to a specific deployment).
2. Go to **Storage → Create Database → Blob**.
3. Once created, copy its `BLOB_READ_WRITE_TOKEN` — you'll need it both here and (implicitly,
   since the main app just fetches the resulting public URL) nowhere else, since the main app
   never writes to Blob itself, only reads the URL this service hands back.

## 5. Configure environment variables

```
cp .env.example .env
```

Edit `.env` and fill in:

- `HELPER_SECRET` — generate one with `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`.
  Copy this exact value into the main app's `YTDLP_HELPER_SECRET` Vercel environment variable too.
- `BLOB_READ_WRITE_TOKEN` — from step 4.
- `PORT` — defaults to 8088; change if that port is already in use.
- `YTDLP_PATH` — leave as the default `./.venv/bin/yt-dlp` if you followed step 3 as-is.

## 6. Run it as a systemd service (recommended)

Create `/etc/systemd/system/ytdlp-helper.service`:

```ini
[Unit]
Description=repost-app yt-dlp helper
After=network.target

[Service]
Type=simple
User=your-user
WorkingDirectory=/home/your-user/ytdlp-helper
EnvironmentFile=/home/your-user/ytdlp-helper/.env
ExecStart=/usr/bin/node server.js
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
```

Replace `your-user` and the path with your actual username/path, and confirm `/usr/bin/node`
matches `which node` (use the full path — systemd doesn't read your shell's PATH/nvm setup).

Then:

```
sudo systemctl daemon-reload
sudo systemctl enable ytdlp-helper
sudo systemctl start ytdlp-helper
sudo systemctl status ytdlp-helper
journalctl -u ytdlp-helper -f    # tail logs
```

### Alternative: PM2

If you'd rather use PM2 (e.g. because you already manage other Node apps on this VPS with it):

```
npm install -g pm2
cd /home/your-user/ytdlp-helper
pm2 start server.js --name ytdlp-helper --env-file .env
pm2 save
pm2 startup   # follow the printed instructions to enable on-boot start
```

`pm2 logs ytdlp-helper` tails logs; `pm2 restart ytdlp-helper` picks up a changed `.env` (PM2
doesn't hot-reload env files — restart is required after editing `.env`).

## 7. Put this behind HTTPS

The main app calls this service over the public internet, so it needs TLS — plain HTTP would send
your `HELPER_SECRET` bearer token and the video data in cleartext. The simplest approach is an
nginx reverse proxy with a free Let's Encrypt certificate:

```
sudo apt-get install -y nginx certbot python3-certbot-nginx
```

Point a DNS A record at this VPS (e.g. `ytdlp-helper.thetwopisceans.com`), then:

```nginx
# /etc/nginx/sites-available/ytdlp-helper
server {
    listen 80;
    server_name ytdlp-helper.thetwopisceans.com;

    location / {
        proxy_pass http://127.0.0.1:8088;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        client_max_body_size 200M;   # Reels can be sizeable; this service streams the file through as a response, not a request body, but keep this generous
    }
}
```

```
sudo ln -s /etc/nginx/sites-available/ytdlp-helper /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx
sudo certbot --nginx -d ytdlp-helper.thetwopisceans.com
```

Certbot will auto-configure the HTTPS redirect and set up auto-renewal.

## 8. Point the main app at it

In the main repost-app's Vercel project environment variables, set:

- `YTDLP_HELPER_URL` = `https://ytdlp-helper.thetwopisceans.com/download`
- `YTDLP_HELPER_SECRET` = the same `HELPER_SECRET` value from step 5

## 9. Verify

```
curl https://ytdlp-helper.thetwopisceans.com/health
```

Should return `{"ok":true,"ytdlpPath":"..."}`. Then test a real download once the main app is also
deployed (or manually):

```
curl -X POST https://ytdlp-helper.thetwopisceans.com/download \
  -H "Authorization: Bearer YOUR_HELPER_SECRET" \
  -H "Content-Type: application/json" \
  -d '{"permalink":"https://www.instagram.com/reel/SOME_PUBLIC_REEL_ID/"}'
```

Should return `{"blobUrl":"https://....public.blob.vercel-storage.com/ig-reels/....mp4"}` after a
short delay. Open that URL in a browser to confirm the video plays.

## Updating later

```
cd /home/your-user/ytdlp-helper
git pull            # or re-scp the updated files
npm install         # if package.json changed
.venv/bin/pip install --upgrade yt-dlp   # Instagram changes frequently break older yt-dlp versions
sudo systemctl restart ytdlp-helper      # or: pm2 restart ytdlp-helper
```

Instagram's page structure changes periodically and can break yt-dlp until it's updated — if
Reels reposting starts failing, upgrading yt-dlp first is the most likely fix.
