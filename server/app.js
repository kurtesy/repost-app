// Builds the Express app object shared by both entry points:
//   - server/index.js   (local dev: `npm run dev` / `npm start`, plain HTTP + optional local HTTPS)
//   - api/index.js       (Vercel: wraps this same app as a single serverless function)
//
// Keeping route logic, middleware order, and cookie-session handling in one place means the
// Vercel deployment behaves identically to local dev rather than risking subtle differences from
// a route-by-route rewrite. db.init() is intentionally NOT called here — callers must await
// ensureDbReady() (server/db/ready.js) before handling a request, since Vercel has no one-time
// boot phase and each cold start needs it run again.
const path = require('path');
const express = require('express');
const cookieSession = require('cookie-session');

const { requireAuth } = require('./middleware/auth');

function createApp() {
  const authRoutes = require('./routes/auth');
  const apiRoutes = require('./routes/api');
  const cronRoutes = require('./routes/cron');

  const app = express();
  app.use(express.json());
  app.use(cookieSession({
    name: 'session',
    secret: process.env.SESSION_SECRET || 'dev-secret',
    maxAge: 30 * 24 * 60 * 60 * 1000
  }));

  // Cron-tick has its own bearer-token auth (CRON_SECRET), checked inside the route itself —
  // it must NOT go through the dashboard password gate (Vercel Cron has no session cookie).
  app.use('/api/cron', cronRoutes);

  // Everything else — the dashboard's static assets and every /auth, /api route — requires the
  // signed session's `authenticated` flag, except the login endpoint and login page themselves
  // (see isPublicPath() in server/middleware/auth.js).
  app.use(requireAuth);

  app.use(express.static(path.join(__dirname, '..', 'public')));

  // Clean-URL aliases for the legal pages, matching the exact paths the separate "repost-tool"
  // Vercel project used to serve at its own domain (see server/middleware/auth.js's PUBLIC_PATHS
  // for why these must stay reachable without a session) — kept as the canonical URLs so nothing
  // needs to change in Meta/Google/TikTok's app-review submissions or TikTok's registered
  // redirect URI, only the domain those URLs are now hosted on.
  const LEGAL_DIR = path.join(__dirname, '..', 'public', 'legal');
  app.get('/legal', (req, res) => res.sendFile(path.join(LEGAL_DIR, 'index.html')));
  app.get('/privacy', (req, res) => res.sendFile(path.join(LEGAL_DIR, 'privacy.html')));
  app.get('/terms', (req, res) => res.sendFile(path.join(LEGAL_DIR, 'terms.html')));
  app.get('/tiktok-callback', (req, res) => res.sendFile(path.join(LEGAL_DIR, 'tiktok-callback.html')));
  app.get('pm3k-verify.txt', (req, res) => res.sendFile('pm3k-verify.txt'));


  app.use('/auth', authRoutes);
  app.use('/api', apiRoutes);

  return app;
}

module.exports = { createApp };
