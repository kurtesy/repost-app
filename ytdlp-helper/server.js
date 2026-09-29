// Standalone, always-on helper service for repost-app's Instagram Reel downloads.
//
// Why this exists: the main repost-app is deployed as Vercel serverless functions, which cannot
// spawn arbitrary binaries (no yt-dlp) and have no persistent process (no long-lived downloads).
// This service runs on a normal VPS instead, where yt-dlp can be installed and invoked like any
// other CLI tool. The main app calls POST /download over HTTPS with an Instagram permalink; this
// service runs yt-dlp against it, uploads the resulting video to Vercel Blob (shared storage both
// services can reach), and returns the blob's public URL. The main app then does a plain HTTPS
// GET on that URL to pull the file down to its own os.tmpdir() for the actual repost.
//
// Auth: a single shared secret, sent by the caller as `Authorization: Bearer <HELPER_SECRET>`.
// This is intentionally simple (one trusted caller, not a public API) but still required — this
// service can be made to spend CPU/bandwidth running yt-dlp and Vercel Blob upload/storage quota,
// so it must not be left open to the internet.

// Loads .env into process.env for local `npm start` / `node server.js` runs. A real systemd
// deployment (see DEPLOY.md) sets env vars via `EnvironmentFile=` instead, in which case they're
// already in process.env before Node even starts and this call is a harmless no-op (dotenv never
// overwrites a variable that's already set) — same pattern the main app's own entry points use.
require('dotenv').config();

const path = require('path');
const os = require('os');
const fs = require('fs');
const crypto = require('crypto');
const { execFile } = require('child_process');
const express = require('express');
const { put } = require('@vercel/blob');

const PORT = process.env.PORT || 8088;
const HELPER_SECRET = process.env.HELPER_SECRET;
// A relative YTDLP_PATH (e.g. the .env.example default './.venv/bin/yt-dlp') must NOT be handed
// straight to execFile/spawn as-is — Node resolves a relative executable path against the
// process's current working directory, not against this file's own directory. If this service
// is ever started from a different cwd than ytdlp-helper/ (a systemd unit with a different
// WorkingDirectory, a wrapper script, PM2 started from the repo root, etc.), a relative path
// silently points at the wrong place and spawn() fails with ENOENT even though the venv exists
// exactly where it's supposed to. path.resolve() (not path.join()) against __dirname fixes this
// for a relative path while leaving an absolute YTDLP_PATH (or the default) untouched.
const YTDLP_PATH = process.env.YTDLP_PATH
  ? path.resolve(__dirname, process.env.YTDLP_PATH)
  : path.join(__dirname, '.venv', 'bin', 'yt-dlp');
const BLOB_TOKEN = process.env.BLOB_READ_WRITE_TOKEN;

// Local-dev fallback: when no BLOB_READ_WRITE_TOKEN is configured, this service serves the
// downloaded file itself over plain HTTP instead of uploading to Vercel Blob, so Reels can be
// tested against a locally-run helper without needing a real Vercel Blob store just for that.
// PUBLIC_BASE_URL is what the returned blobUrl is built from — the main app does a plain HTTP GET
// on whatever URL comes back (see instagram.js's downloadReelViaHelper), so this works exactly
// the same way a real Blob URL would from its point of view. NOT suitable for production: no
// auth on the file-serving route, no TTL/cleanup beyond process restart, and it only works if the
// main app can reach this service's own host/port directly (fine for same-machine local dev,
// not for a real deployment across two separate hosts — use a real Blob store there).
const LOCAL_SERVE_DIR = path.join(os.tmpdir(), 'ytdlp-helper-local-serve');
const PUBLIC_BASE_URL = (process.env.PUBLIC_BASE_URL || `http://localhost:${PORT}`).replace(/\/$/, '');
const USE_LOCAL_SERVE = !BLOB_TOKEN;

// Fail loudly and immediately rather than silently accepting unauthenticated requests or failing
// confusingly on the first real upload attempt — same philosophy as the main app's
// assertDashboardPasswordConfigured(). BLOB_READ_WRITE_TOKEN is no longer hard-required: its
// absence just switches this service into local-serve mode (see above) rather than refusing to
// start, since that mode is a legitimate way to run this for local development.
function assertConfigured() {
  const missing = [];
  if (!HELPER_SECRET) missing.push('HELPER_SECRET');
  if (missing.length) {
    console.error(
      `[ytdlp-helper] Refusing to start — missing required env var(s): ${missing.join(', ')}. ` +
      `Copy .env.example to .env (or set these in your systemd unit / PM2 ecosystem file) before starting.`
    );
    process.exit(1);
  }

  // Fail at startup with a clear message rather than only discovering a broken/missing yt-dlp
  // path on the first real /download request, where it surfaces as an opaque
  // "spawn <path> ENOENT" deep inside a repost attempt (exactly the bug this check now catches).
  if (!fs.existsSync(YTDLP_PATH)) {
    console.error(
      `[ytdlp-helper] Refusing to start — no yt-dlp executable found at "${YTDLP_PATH}". ` +
      (process.env.YTDLP_PATH
        ? `YTDLP_PATH is set to "${process.env.YTDLP_PATH}" in your .env, which resolved to the ` +
          `path above — check that the venv actually exists there (see DEPLOY.md step 3 / ` +
          `"Local development"), or unset YTDLP_PATH to use the default project-local venv.`
        : `Run the venv setup steps in DEPLOY.md ("Local development" section, or step 3 for a ` +
          `VPS) from inside this ytdlp-helper/ folder: python3 -m venv .venv && ` +
          `.venv/bin/pip install yt-dlp`)
    );
    process.exit(1);
  }

  if (USE_LOCAL_SERVE) {
    fs.mkdirSync(LOCAL_SERVE_DIR, { recursive: true });
    console.warn(
      '[ytdlp-helper] BLOB_READ_WRITE_TOKEN is not set — running in LOCAL-SERVE mode: ' +
      'downloaded files are served directly by this process instead of being uploaded to ' +
      'Vercel Blob. This is fine for local development but is NOT suitable for a real ' +
      'deployment (no auth on the file route, no cleanup, and the main app must be able to ' +
      'reach this service directly). Set BLOB_READ_WRITE_TOKEN to use real Blob storage instead.'
    );
  }
}
assertConfigured();

const app = express();
app.use(express.json());

if (USE_LOCAL_SERVE) {
  // Serves files this service just downloaded, at the same path it hands back as `blobUrl`.
  // Deliberately unauthenticated (matching a real public Blob URL's own access model) — the
  // filenames are random 16-hex-char tokens, acting as an unguessable-URL capability rather than
  // a real access control. Only appropriate for local dev, per the warning above.
  app.use('/local-blob', express.static(LOCAL_SERVE_DIR));
}

// Constant-time comparison, mirroring the main app's own password-gate logic, to avoid leaking a
// length/content timing signal on the shared secret.
function secretMatches(candidate) {
  const a = Buffer.from(String(candidate || ''), 'utf8');
  const b = Buffer.from(String(HELPER_SECRET), 'utf8');
  if (a.length !== b.length) {
    crypto.timingSafeEqual(a, a);
    return false;
  }
  return crypto.timingSafeEqual(a, b);
}

function requireAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const [scheme, token] = header.split(' ');
  if (scheme !== 'Bearer' || !token || !secretMatches(token)) {
    return res.status(401).json({ error: 'Missing or invalid Authorization header.' });
  }
  next();
}

// Defense-in-depth: only ever hand yt-dlp a genuine instagram.com URL, matching the same guard
// the main app already applies before calling this service (server/services/instagram.js).
const IG_URL_RE = /^https:\/\/(www\.)?instagram\.com\//i;

function runYtDlp(permalink, destPath) {
  return new Promise((resolve, reject) => {
    execFile(
      YTDLP_PATH,
      [
        permalink,
        '-f', 'mp4/best',
        '-o', destPath,
        '--no-playlist',
        '--no-warnings'
      ],
      { timeout: 5 * 60 * 1000, maxBuffer: 10 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err) {
          return reject(new Error(
            `yt-dlp failed (${err.code || err.signal || 'error'}): ${(stderr || err.message || '').slice(0, 2000)}`
          ));
        }
        resolve();
      }
    );
  });
}

app.get('/health', (req, res) => {
  res.json({ ok: true, ytdlpPath: YTDLP_PATH, mode: USE_LOCAL_SERVE ? 'local-serve' : 'vercel-blob' });
});

app.post('/download', requireAuth, async (req, res) => {
  const permalink = req.body?.permalink;

  if (!permalink || typeof permalink !== 'string') {
    return res.status(400).json({ error: 'Request body must include a string `permalink`.' });
  }
  if (!IG_URL_RE.test(permalink)) {
    return res.status(400).json({ error: 'permalink must be a genuine https://instagram.com/... URL.' });
  }

  const tmpFile = path.join(os.tmpdir(), `ytdlp-${crypto.randomBytes(8).toString('hex')}.mp4`);

  try {
    await runYtDlp(permalink, tmpFile);

    if (!fs.existsSync(tmpFile) || fs.statSync(tmpFile).size === 0) {
      throw new Error('yt-dlp reported success but produced no output file (or an empty one).');
    }

    let blobUrl;
    if (USE_LOCAL_SERVE) {
      // Move (not copy) into the served directory, named with a fresh random token — the temp
      // download path itself is never exposed.
      const servedName = `${crypto.randomBytes(8).toString('hex')}.mp4`;
      fs.renameSync(tmpFile, path.join(LOCAL_SERVE_DIR, servedName));
      blobUrl = `${PUBLIC_BASE_URL}/local-blob/${servedName}`;
    } else {
      const blobName = `ig-reels/${crypto.randomBytes(8).toString('hex')}.mp4`;
      const fileBuffer = fs.readFileSync(tmpFile);
      const blob = await put(blobName, fileBuffer, {
        access: 'public',
        token: BLOB_TOKEN,
        contentType: 'video/mp4',
        addRandomSuffix: false
      });
      blobUrl = blob.url;
    }

    res.json({ blobUrl });
  } catch (err) {
    console.error('[ytdlp-helper] /download failed:', err.message);
    res.status(500).json({ error: err.message });
  } finally {
    // Always clean up the local temp file regardless of success/failure — this VPS's disk is
    // small and long-lived compared to Vercel's per-invocation tmpdir, so leftover files would
    // otherwise accumulate indefinitely across requests. In local-serve mode the file was already
    // moved out of tmpFile's path above (rather than copied), so this is a no-op there — the
    // served copy under LOCAL_SERVE_DIR is intentionally left for the main app to fetch.
    fs.promises.unlink(tmpFile).catch(() => {});
  }
});

app.listen(PORT, () => {
  console.log(`[ytdlp-helper] listening on port ${PORT} (yt-dlp: ${YTDLP_PATH})`);
});
