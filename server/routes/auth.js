const express = require('express');
const router = express.Router();
const instagram = require('../services/instagram');
const youtube = require('../services/youtube');
const tiktok = require('../services/tiktok');
const { clearToken } = require('../db/tokens');
const { safeErrorMessage } = require('../services/errors');
const { passwordMatches } = require('../middleware/auth');

// --- Dashboard password gate (single shared password, no user accounts) ---
// Mounted before requireAuth would otherwise block it — see isPublicPath() in
// server/middleware/auth.js, which allowlists this exact path.
router.post('/login', (req, res) => {
  const password = req.body?.password;
  if (!passwordMatches(password)) {
    return res.status(401).json({ error: 'Incorrect password' });
  }
  req.session.authenticated = true;
  res.json({ ok: true });
});

router.post('/logout', (req, res) => {
  req.session = null;
  res.json({ ok: true });
});

router.get('/instagram', (req, res) => res.redirect(instagram.authUrl()));
router.get('/instagram/callback', async (req, res) => {
  try {
    await instagram.exchangeCodeForToken(req.query.code);
    res.redirect('/?connected=instagram');
  } catch (err) {
    res.status(500).send('Instagram auth failed: ' + safeErrorMessage(err));
  }
});

router.get('/youtube', (req, res) => res.redirect(youtube.authUrl()));
router.get('/youtube/callback', async (req, res) => {
  try {
    await youtube.exchangeCodeForToken(req.query.code);
    res.redirect('/?connected=youtube');
  } catch (err) {
    res.status(500).send('YouTube auth failed: ' + safeErrorMessage(err));
  }
});

router.get('/tiktok', (req, res) => res.redirect(tiktok.authUrl()));

// Primary TikTok OAuth callback — TT_REDIRECT_URI now points directly here (see .env.example),
// exactly like Instagram/YouTube's own callbacks below. This route is public (no dashboard
// session required — see server/middleware/auth.js's PUBLIC_PATHS) since TikTok's redirect hits
// it directly, not the dashboard's own authenticated JS.
//
// Historical note: this app originally couldn't use a direct callback here because TikTok's
// Login Kit rejects "localhost" redirect URIs, and at the time this relay lived on a completely
// separate domain (repost-tool.vercel.app) with no way to hand the code back into this app
// automatically — hence the old manual copy/paste flow (public/legal/tiktok-callback.html +
// POST /tiktok/complete below). Now that this app is itself hosted on a real HTTPS domain, that
// workaround is unnecessary; this route handles the redirect directly. The old relay page and
// /tiktok/complete are kept as a fallback/escape hatch, not removed.
router.get('/tiktok/callback', async (req, res) => {
  try {
    await tiktok.exchangeCodeForToken(req.query.code);
    res.redirect('/?connected=tiktok');
  } catch (err) {
    res.status(500).send('TikTok auth failed: ' + safeErrorMessage(err));
  }
});

router.post('/tiktok/complete', async (req, res) => {
  try {
    const code = (req.body?.code || '').trim();
    if (!code) return res.status(400).json({ error: 'Paste the authorization code from the TikTok relay page first.' });
    await tiktok.exchangeCodeForToken(code);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: safeErrorMessage(err) });
  }
});

const VALID_PROVIDERS = ['instagram', 'youtube', 'tiktok'];

// Disconnect a platform: clears its stored token so the dashboard shows it as "Not connected"
// and the Connect button starts a fresh OAuth flow. Useful when a refresh token has died
// (e.g. Google's invalid_grant after a Testing-mode app's 7-day token expiry) — reconnecting
// without disconnecting first can otherwise reuse a stale, still-invalid refresh token.
router.post('/:provider/disconnect', async (req, res) => {
  try {
    const { provider } = req.params;
    if (!VALID_PROVIDERS.includes(provider)) {
      return res.status(400).json({ error: 'Unknown provider: ' + provider });
    }
    await clearToken(provider);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: safeErrorMessage(err) });
  }
});

router.get('/status', async (req, res) => {
  try {
    const [ig, yt, tt] = await Promise.all([
      instagram.isConnected(),
      youtube.isConnected(),
      tiktok.isConnected()
    ]);
    res.json({ instagram: ig, youtube: yt, tiktok: tt });
  } catch (err) {
    res.status(500).json({ error: safeErrorMessage(err) });
  }
});

module.exports = router;
