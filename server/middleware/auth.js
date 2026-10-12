const crypto = require('crypto');

// Paths that must remain reachable without a session, so the login page itself can load and
// authenticate. Everything else (both API routes and the dashboard HTML) is gated.
//
// Note: this app's existing routing mounts the auth router at /auth (not /api/auth — see
// server/index.js / api/index.js), so the login endpoint here is POST /auth/login. The task
// brief's suggested path (/api/auth/login) was adapted to match the app's actual existing route
// structure rather than renaming ~15 established routes.
const PUBLIC_PATHS = new Set([
  '/auth/login',
  '/login.html',
  // Legal pages + TikTok OAuth relay + TikTok's domain-verification file — formerly hosted on a
  // completely separate Vercel project ("repost-tool", the legal/ folder) with no auth of its
  // own; folded into this app's own deployment so there's only one project to manage, but they
  // must stay reachable without a dashboard session for the same reasons that separate project
  // never had a password gate: Meta/Google/TikTok's automated app-review crawlers fetch
  // /privacy and /terms unauthenticated, TikTok's own servers hit /tiktok-callback directly as
  // part of its OAuth redirect (same category as the /auth/*/callback routes below — a TikTok-
  // issued authorization code, not a secret, so there's nothing meaningful to protect here), and
  // TikTok's domain-ownership check fetches the verification .txt file directly, also
  // unauthenticated. Gating any of these would break OAuth reconnects or fail app review.
  '/legal',
  '/legal/index.html',
  '/privacy',
  '/legal/privacy.html',
  '/terms',
  '/legal/terms.html',
  '/tiktok-callback',
  '/legal/tiktok-callback.html',
  '/tiktokQqJHfRpq8RLRODEPr4hBUfs9wiH4DcQa.txt'
]);

// OAuth redirect callbacks — hit directly by Meta/Google/TikTok's servers after the user
// approves access, not by our own dashboard JS. The browser making this request is normally
// the same one that clicked "Connect" while logged in, so it usually *does* carry a valid
// session cookie — but that's not guaranteed: a cross-site redirect can be affected by
// SameSite cookie policies, the session may have expired mid-flow, or the user could be
// reconnecting from a different browser/device than the one they're viewing the dashboard in.
// Blocking these on a missing/expired session would surface as a confusing 401 instead of
// completing the OAuth handshake. This is safe to leave unauthenticated: the `code` query
// param each of these routes consumes is single-use, issued by the platform only after that
// platform's OWN login/consent screen, and scoped to this app's client id/secret — an attacker
// can't forge a usable code without first completing that platform's consent flow themselves,
// at which point they'd only be linking their own account, not gaining access to this one.
const PUBLIC_PATH_PREFIXES = [
  '/auth/instagram/callback',
  '/auth/youtube/callback',
  '/auth/tiktok/callback'
];

/**
 * True if `reqPath` should bypass the auth gate: the login page/endpoint, and the OAuth
 * callback routes documented above.
 */
function isPublicPath(reqPath) {
  if (PUBLIC_PATHS.has(reqPath)) return true;
  return PUBLIC_PATH_PREFIXES.some((p) => reqPath === p || reqPath.startsWith(p + '?'));
}

/**
 * Constant-time comparison of the supplied password against DASHBOARD_PASSWORD, guarding
 * against timing attacks. Returns false (never throws) on any length mismatch or missing input.
 */
function passwordMatches(candidate) {
  const expected = process.env.DASHBOARD_PASSWORD;
  if (!expected) return false;
  const a = Buffer.from(String(candidate || ''), 'utf8');
  const b = Buffer.from(String(expected), 'utf8');
  if (a.length !== b.length) {
    // Still run a timingSafeEqual-shaped comparison against a same-length buffer so this
    // branch's timing doesn't trivially reveal "wrong length" vs "wrong content" — not perfect,
    // but avoids the cheapest length-based timing signal.
    crypto.timingSafeEqual(a, a);
    return false;
  }
  return crypto.timingSafeEqual(a, b);
}

/**
 * Must be called once before the app serves any request. Vercel's serverless functions have no
 * long-lived boot phase to do this once, so both the local dev server (server/index.js) and the
 * Vercel handler (api/index.js) call this at the very top of their request path — throwing here
 * turns into a fast, loud failure (500 locally / to the invoking code) rather than silently
 * running with no password ever accepted.
 */
function assertDashboardPasswordConfigured() {
  if (!process.env.DASHBOARD_PASSWORD) {
    const msg =
      'DASHBOARD_PASSWORD is not set. Refusing to serve the app without it — set this env var ' +
      '(a long random string) before starting the server. Defaulting to "no password" would leave ' +
      'the dashboard and every API route open to the public internet.';
    console.error('[auth] ' + msg);
    throw new Error(msg);
  }
}

/**
 * Express middleware enforcing the single shared-password gate on every route except the login
 * endpoint. Reuses the existing cookie-session middleware (already mounted in both entry points)
 * rather than introducing a second session mechanism — cookie-session signs the whole cookie
 * with SESSION_SECRET, so `req.session.authenticated = true` is tamper-evident the same way the
 * rest of the session object already is.
 */
function requireAuth(req, res, next) {
  const reqPath = req.path;

  if (isPublicPath(reqPath)) return next();

  if (req.session && req.session.authenticated) return next();

  // Distinguish API calls (JSON 401) from everything else (HTML dashboard requests, which get
  // redirected to the static login page) — mirrors how public/index.html's own `api()` helper
  // already expects JSON error bodies from /api/* and /auth/* routes.
  const wantsJson =
    reqPath.startsWith('/api/') ||
    reqPath.startsWith('/auth/') ||
    (req.headers.accept || '').includes('application/json');

  if (wantsJson) {
    return res.status(401).json({ error: 'Not authenticated', loginRequired: true });
  }
  return res.redirect('/login.html');
}

module.exports = {
  requireAuth,
  passwordMatches,
  assertDashboardPasswordConfigured,
  isPublicPath
};
