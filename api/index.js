// Vercel serverless entry point.
//
// Approach chosen (see the task's option (a)): wrap the EXISTING Express app as a single
// catch-all function rather than rewriting ~15 routes into one-file-per-route Vercel functions.
// vercel.json rewrites LITERALLY EVERYTHING (including what would otherwise be Vercel's own
// automatic static-file serving of public/) to this one file — a deliberate fix for an earlier
// bug where static files bypassed requireAuth entirely. This preserves all existing route logic,
// middleware order (cookie-session -> auth gate -> static -> /auth -> /api), and error handling
// with minimal rewriting, at the cost of every request (even ones only hitting one route)
// cold-starting/warming this single function — an acceptable tradeoff for an app of this size on
// the Hobby plan.
//
// Vercel's Node.js runtime natively supports exporting an Express app instance as the default
// handler from a file under /api — Express's own (req, res) => {...} signature is compatible
// with what Vercel's Node runtime invokes, so no serverless-http-style adapter package is needed.
require('dotenv').config();
const { createApp } = require('../server/app');
const { ensureDbReady } = require('../server/db/ready');
const { assertDashboardPasswordConfigured } = require('../server/middleware/auth');

// Built once per cold start (module-level), reused across warm invocations of the same
// container — mirrors how the DB pool in server/db/index.js already caches itself at module
// scope. A fresh cold start re-runs this whole module, producing a fresh app/pool pair.
const app = createApp();

module.exports = async (req, res) => {
  try {
    // Throws loudly (500) if DASHBOARD_PASSWORD is unset, rather than silently serving with no
    // password ever accepted — checked on every invocation since it's just an env var read, not
    // an expensive operation like ensureDbReady().
    assertDashboardPasswordConfigured();

    // Cold start: runs db.init() (creates tables / migrations) once for this container.
    // Warm invocation: resolves immediately (memoized) — see server/db/ready.js.
    await ensureDbReady();
  } catch (err) {
    console.error('[api] startup check failed:', err);
    res.status(500).json({ error: 'Server misconfigured: ' + err.message });
    return;
  }

  return app(req, res);
};
