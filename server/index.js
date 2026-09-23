require('dotenv').config();
const fs = require('fs');
const path = require('path');
const https = require('https');
const express = require('express');
const cookieSession = require('cookie-session');
const db = require('./db');

const CERT_DIR = path.join(__dirname, '..', 'certs');
const CERT_FILE = path.join(CERT_DIR, 'localhost.pem');
const KEY_FILE = path.join(CERT_DIR, 'localhost-key.pem');

async function main() {
  // sql.js loads its WASM module asynchronously — must finish before any route touches the DB.
  await db.init();

  const authRoutes = require('./routes/auth');
  const apiRoutes = require('./routes/api');
  const scheduler = require('./services/scheduler');

  const app = express();
  app.use(express.json());
  app.use(cookieSession({
    name: 'session',
    secret: process.env.SESSION_SECRET || 'dev-secret',
    maxAge: 30 * 24 * 60 * 60 * 1000
  }));

  app.use(express.static(path.join(__dirname, '..', 'public')));
  app.use('/auth', authRoutes);
  app.use('/api', apiRoutes);

  const PORT = process.env.PORT || 3011;
  const HTTPS_PORT = process.env.HTTPS_PORT || 3443;

  // Plain HTTP — used for the dashboard and for IG/YouTube, which accept http://localhost redirect URIs.
  app.listen(PORT, () => {
    console.log(`HTTP:  ${process.env.BASE_URL || 'http://localhost:' + PORT}`);
    scheduler.reloadAll();
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
