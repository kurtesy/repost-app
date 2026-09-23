const express = require('express');
const router = express.Router();
const instagram = require('../services/instagram');
const youtube = require('../services/youtube');
const tiktok = require('../services/tiktok');
const { clearToken } = require('../db/tokens');
const { safeErrorMessage } = require('../services/errors');

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

// TikTok's Login Kit rejects "localhost" redirect URIs, so TT_REDIRECT_URI points at a small
// static relay page hosted alongside the legal/ site on Vercel instead of this route. That page
// shows the user the authorization code on screen; they paste it into the dashboard, which POSTs
// it here to finish the token exchange. Kept as a GET route too in case TT_REDIRECT_URI is ever
// pointed directly back at this server (e.g. once a custom domain is set up for it).
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
router.post('/:provider/disconnect', (req, res) => {
  const { provider } = req.params;
  if (!VALID_PROVIDERS.includes(provider)) {
    return res.status(400).json({ error: 'Unknown provider: ' + provider });
  }
  clearToken(provider);
  res.json({ ok: true });
});

router.get('/status', (req, res) => {
  res.json({
    instagram: instagram.isConnected(),
    youtube: youtube.isConnected(),
    tiktok: tiktok.isConnected()
  });
});

module.exports = router;
