// LOCAL-DEV-ONLY entry point. Run via `npm run dev` / `npm start`.
//
// This boots a normal long-lived Express process (with app.listen + optional local HTTPS for
// TikTok's redirect-URI requirement) — none of which exists on Vercel. The actual production
// deployment target is api/index.js, which wraps the SAME Express app (built by server/app.js)
// as a single Vercel serverless function. Any route/middleware change belongs in server/app.js,
// server/routes/*, or server/middleware/* so both entry points stay in sync automatically.
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const https = require('https');
const db = require('./db');
const { assertDashboardPasswordConfigured } = require('./middleware/auth');
const { createApp } = require('./app');

const CERT_DIR = path.join(__dirname, '..', 'certs');
const CERT_FILE = path.join(CERT_DIR, 'localhost.pem');
const KEY_FILE = path.join(CERT_DIR, 'localhost-key.pem');

async function main() {
  // Fails fast and loudly if DASHBOARD_PASSWORD isn't set — see server/middleware/auth.js.
  assertDashboardPasswordConfigured();

  // Verifies Postgres connectivity and runs migrations — must finish before any route touches
  // the DB. Local dev keeps the old one-time-boot style (simpler than the lazy/memoized
  // ensureDbReady() used by the Vercel entry point, since a long-running process only needs
  // this once anyway).
  await db.init();

  const app = createApp();

  // node-cron based scheduling (server/services/scheduler.js) has been REMOVED from the
  // serverless build entirely — its in-process timers can't survive Vercel's per-invocation
  // execution model. It is NOT reintroduced here either, so local dev and the deployed app
  // behave identically: scheduled workflows only run when something calls
  // GET /api/cron/tick (Vercel Cron in production; call it manually or with a local cron/curl
  // loop during local dev if you want to exercise scheduling without deploying).

  const PORT = process.env.PORT || 3011;
  const HTTPS_PORT = process.env.HTTPS_PORT || 3443;

  // Plain HTTP — used for the dashboard and for IG/YouTube, which accept http://localhost redirect URIs.
  app.listen(PORT, () => {
    console.log(`HTTP:  ${process.env.BASE_URL || 'http://localhost:' + PORT}`);
  });

  // Optional local HTTPS — required by TikTok, which rejects non-https redirect URIs.
  // Generate certs first with mkcert (see SETUP.md, section 3 "Local HTTPS for TikTok").
  if (fs.existsSync(CERT_FILE) && fs.existsSync(KEY_FILE)) {
    https.createServer({
      cert: fs.readFileSync(CERT_FILE),
      key: fs.readFileSync(KEY_FILE)
    }, app).listen(HTTPS_PORT, () => {
      console.log(`HTTPS: https://localhost:${HTTPS_PORT}  (use this origin for TikTok's redirect URI)`);
    });
  } else {
    console.log(`HTTPS: not started — no certs found at ${CERT_FILE}.`);
    console.log(`       TikTok requires an https:// redirect URI. See SETUP.md section 3 to generate local certs with mkcert.`);
  }
}

main().catch((err) => {
  console.error('Failed to start app:', err);
  process.exit(1);
});
