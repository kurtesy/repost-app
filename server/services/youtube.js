const fs = require('fs');
const { google } = require('googleapis');
const { getToken, saveToken } = require('../db/tokens');
const db = require('../db');
const { toYouTubeTitle } = require('./caption');

function oauthClient() {
  return new google.auth.OAuth2(
    process.env.YT_CLIENT_ID,
    process.env.YT_CLIENT_SECRET,
    process.env.YT_REDIRECT_URI
  );
}

function authUrl() {
  const client = oauthClient();
  return client.generateAuthUrl({
    access_type: 'offline',
    // CORRECTED (previous comment here was wrong and caused real failures — see the
    // "Invalid Credentials"/missing-refresh-token bug this fixed): Google only issues a
    // refresh_token when the consent screen is actually rendered and re-approved, not merely on
    // "first connect ever." access_type:'offline' alone does NOT guarantee one on every
    // authorization — if Google still considers consent already granted for this account+app+
    // scope combination (which it will, on any reconnect after the first), it skips the consent
    // screen entirely and returns an access_token with NO refresh_token, even though the user
    // went through the full Connect flow. `prompt` DOES accept a space-delimited list of values
    // (contrary to what this comment previously claimed) — 'consent select_account' shows both
    // the account chooser AND forces the consent screen to render (and be re-approved) every
    // single time, which is what actually guarantees a fresh refresh_token on every connect,
    // including reconnects for an account that was already connected before.
    prompt: 'consent select_account',
    scope: ['https://www.googleapis.com/auth/youtube.upload', 'https://www.googleapis.com/auth/youtube']
  });
}

async function exchangeCodeForToken(code) {
  const client = oauthClient();
  const { tokens } = await client.getToken(code);

  if (!tokens.refresh_token) {
    // Should now be rare with prompt:'consent select_account' above forcing re-approval every
    // time, but fail loudly here rather than silently saving an access-token-only connection
    // that would otherwise die confusingly ~1 hour later on the next repost attempt. Falling
    // back to any existing stored refresh_token (if this is a reconnect of an account that
    // still has one on file) avoids needlessly breaking a connection that was actually fine.
    const existing = await getToken('youtube');
    if (existing?.refresh_token) {
      await saveToken('youtube', {
        access_token: tokens.access_token,
        refresh_token: existing.refresh_token,
        expires_at: tokens.expiry_date || null
      });
      return tokens;
    }
    throw new Error(
      'Google did not return a refresh token for this connection, and none was already on ' +
      'file. Revoke this app\'s access from https://myaccount.google.com/permissions (look for ' +
      'this app under "Third-party apps with account access"), then try Connect again — ' +
      'revoking first forces Google to issue a brand new refresh token on the next consent.'
    );
  }

  await saveToken('youtube', {
    access_token: tokens.access_token,
    refresh_token: tokens.refresh_token,
    expires_at: tokens.expiry_date || null
  });
  return tokens;
}

async function getAuthedClient() {
  const tok = await getToken('youtube');
  if (!tok) throw new Error('YouTube not connected yet.');
  if (!tok.refresh_token) {
    // No refresh_token stored at all — the access_token alone is only good for ~1 hour and,
    // once it expires, there's nothing this client can use to get a new one. This happens if
    // Google didn't issue a refresh_token on connect (e.g. the OAuth consent screen was
    // completed a second time for the same account without a prior disconnect — Google only
    // issues a fresh refresh_token on the FIRST consent per account/client pair unless
    // access_type:'offline' + prompt:'consent' forces a new one; this app uses
    // prompt:'select_account', which does not reliably force it). Surface this clearly instead
    // of letting it fail as an opaque "Invalid Credentials" once the access_token expires.
    throw new Error(
      'No YouTube refresh token is stored, so the connection cannot renew itself once the ' +
      'short-lived access token expires. Disconnect and reconnect YouTube from the dashboard ' +
      '(Settings/top of the dashboard — Disconnect, then Connect again) to get a fresh refresh token.'
    );
  }
  const client = oauthClient();
  // expiry_date is required here, not just access_token/refresh_token: google-auth-library only
  // proactively refreshes the access_token when it can see the current one is expired. Without
  // expiry_date, the library has no way to know that, so it happily sends a stale/expired
  // access_token straight to the API — which YouTube rejects with a bare 401 "Invalid
  // Credentials" (no JSON error body), rather than the library refreshing it first. This was the
  // root cause of "Invalid Credentials" errors on reposts even though a refresh_token existed.
  client.setCredentials({
    access_token: tok.access_token,
    refresh_token: tok.refresh_token,
    expiry_date: tok.expires_at || null
  });
  client.on('tokens', (t) => {
    // Fire-and-forget: this listener callback isn't awaited by googleapis itself, so errors
    // are only logged rather than propagated up through getAuthedClient()'s caller.
    saveToken('youtube', {
      access_token: t.access_token || tok.access_token,
      refresh_token: t.refresh_token || tok.refresh_token,
      expires_at: t.expiry_date || tok.expires_at
    }).catch((err) => console.error('[youtube] failed to persist refreshed token:', err.message));
  });
  return client;
}

/**
 * Translate a googleapis/google-auth-library auth failure into an actionable message. Both a
 * dead refresh token (invalid_grant — commonly a Google Cloud OAuth app still in "Testing"
 * publishing status, where Google auto-expires every refresh token after 7 days) and a stale
 * access_token sent without being refreshed first surface as a bare 401 with no useful JSON body
 * — googleapis' own message for this is just the unhelpful string "Invalid Credentials". Any
 * caller of getAuthedClient() should route its catch block through this rather than letting that
 * raw message reach the Activity Log, where it gives no hint that reconnecting fixes it.
 */
function isAuthError(err) {
  const code = err?.response?.data?.error;
  const status = err?.response?.status || err?.code;
  return (
    err?.message === 'Invalid Credentials' ||
    code === 'invalid_grant' ||
    status === 401
  );
}

function authErrorMessage(err) {
  return (
    `YouTube authentication failed (${err.message || 'Invalid Credentials'}). This usually means ` +
    `the stored connection is no longer valid — most commonly because the Google Cloud OAuth app ` +
    `is still in "Testing" publishing status, where Google auto-expires refresh tokens after 7 ` +
    `days, or because the access was revoked from your Google Account's security settings. Fix: ` +
    `go to the dashboard, Disconnect YouTube, then Connect again to get a fresh token.`
  );
}

/**
 * Upload a video to YouTube. Despite the name (kept for backward compatibility), this isn't
 * Shorts-specific — videos.insert is a generic upload; YouTube itself decides whether something
 * displays as a Short based on the video's actual length/aspect ratio, not anything this call
 * sets explicitly. What controls Shorts vs. regular in practice is the #Shorts tag in the
 * description (see caption.js's toYouTubeDescription asShorts param) — this function just needs
 * to know which URL format to hand back for the activity log.
 * privacyStatus: 'public' | 'unlisted' | 'private'
 */
async function uploadShort({ filePath, title, description, tags = [], privacyStatus = 'public', asShorts = true }) {
  const auth = await getAuthedClient();
  const youtube = google.youtube({ version: 'v3', auth });

  let res;
  try {
    res = await youtube.videos.insert({
      part: ['snippet', 'status'],
      requestBody: {
        snippet: { title, description, tags, categoryId: '22' },
        status: { privacyStatus, selfDeclaredMadeForKids: false }
      },
      media: { body: fs.createReadStream(filePath) }
    });
  } catch (err) {
    if (isAuthError(err)) throw new Error(authErrorMessage(err));
    throw err;
  }

  const videoId = res.data.id;
  const url = asShorts
    ? `https://youtube.com/shorts/${videoId}`
    : `https://youtube.com/watch?v=${videoId}`;
  return { id: videoId, url };
}

// --- Existing-channel-history check (catches videos uploaded before this app existed) ---

let uploadsCache = null;       // { titles: [{id, title, publishedAt}], fetchedAt }
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes — avoid re-fetching the whole channel on every post in a batch run

/** Fetch (and cache) the connected channel's full list of uploaded video titles. */
async function fetchChannelUploads({ forceRefresh = false } = {}) {
  if (!forceRefresh && uploadsCache && Date.now() - uploadsCache.fetchedAt < CACHE_TTL_MS) {
    return uploadsCache.titles;
  }

  const auth = await getAuthedClient();
  const youtube = google.youtube({ version: 'v3', auth });

  try {
    const { data: channelData } = await youtube.channels.list({ part: ['contentDetails'], mine: true });
    const uploadsPlaylistId = channelData.items?.[0]?.contentDetails?.relatedPlaylists?.uploads;
    if (!uploadsPlaylistId) {
      uploadsCache = { titles: [], fetchedAt: Date.now() };
      return uploadsCache.titles;
    }

    const titles = [];
    let pageToken;
    do {
      const { data } = await youtube.playlistItems.list({
        part: ['snippet'],
        playlistId: uploadsPlaylistId,
        maxResults: 50,
        pageToken
      });
      for (const item of data.items || []) {
        titles.push({
          id: item.snippet?.resourceId?.videoId,
          title: item.snippet?.title || '',
          publishedAt: item.snippet?.publishedAt || null
        });
      }
      pageToken = data.nextPageToken;
    } while (pageToken);

    uploadsCache = { titles, fetchedAt: Date.now() };
    return titles;
  } catch (err) {
    if (isAuthError(err)) throw new Error(authErrorMessage(err));
    throw err;
  }
}

/** Normalize a title for fuzzy comparison: lowercase, strip punctuation/emoji/extra whitespace. */
function normalizeTitle(title) {
  return (title || '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Simple Levenshtein-based similarity ratio in [0, 1]; 1 = identical. */
function similarity(a, b) {
  if (a === b) return 1;
  if (!a.length || !b.length) return 0;
  const dp = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 0; j <= b.length; j++) dp[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      dp[i][j] = a[i - 1] === b[j - 1]
        ? dp[i - 1][j - 1]
        : 1 + Math.min(dp[i - 1][j - 1], dp[i - 1][j], dp[i][j - 1]);
    }
  }
  const distance = dp[a.length][b.length];
  return 1 - distance / Math.max(a.length, b.length);
}

/**
 * Check whether a candidate title likely already exists on the connected YouTube channel —
 * including videos uploaded before this app was ever used, since it looks at the real channel,
 * not just this app's own local post_log.
 * Returns { isDuplicate, match } where match is the closest existing video found (if any).
 */
async function findLikelyDuplicate(candidateTitle, { threshold = 0.85 } = {}) {
  const uploads = await fetchChannelUploads();
  const normCandidate = normalizeTitle(candidateTitle);
  if (!normCandidate) return { isDuplicate: false, match: null };

  let best = null;
  for (const video of uploads) {
    const score = similarity(normCandidate, normalizeTitle(video.title));
    if (!best || score > best.score) best = { ...video, score };
  }

  if (best && best.score >= threshold) {
    return { isDuplicate: true, match: best };
  }
  return { isDuplicate: false, match: best };
}

/**
 * Reconcile this app's post_log against what's actually on the connected YouTube channel.
 *
 * Why this exists: post_log only knows about posts made THROUGH this app. A video can end up on
 * the real channel without a matching post_log row in several ways — it was uploaded manually
 * before this app was ever used, it was reposted by this app before post_log/this DB even
 * existed, or a repost succeeded on YouTube's side but the subsequent logAttempt() write failed
 * (e.g. a dropped DB connection right after upload). Any of these would otherwise cause a
 * workflow to try to repost something that's already live. This walks every stored IG post that
 * isn't already logged as posted-to-YouTube, checks it against the real channel using the same
 * fuzzy-title matching as the pre-post duplicate check (findLikelyDuplicate/similarity), and
 * writes a 'synced' post_log row for anything that matches — a distinct status from 'success' so
 * the Activity Log/UI can still show it as posted while being honest that this app didn't
 * actually perform the upload.
 *
 * Runs its own single fetchChannelUploads({forceRefresh:true}) call up front rather than relying
 * on the 5-minute cache, since the whole point of a manual "sync" click is to see current
 * real-world state, not up to 5 minutes of staleness.
 *
 * Returns { checked, matched, synced[] } — synced holds one entry per newly-written row, for the
 * caller (the API route) to report back to the UI.
 */
async function syncChannelUploads({ threshold = 0.85 } = {}) {
  // fetchChannelUploads -> getAuthedClient already throws a clear 'YouTube not connected yet.'
  // if there's no stored token, so no separate up-front check is needed here.
  const uploads = await fetchChannelUploads({ forceRefresh: true });

  const rows = await db.prepare(
    `SELECT id, caption FROM ig_media ORDER BY timestamp DESC`
  ).all();

  const synced = [];
  for (const row of rows) {
    // Already logged as posted (by a real repost, a previous sync, or a draft) — nothing to do.
    const existing = await db.prepare(
      `SELECT id FROM post_log WHERE ig_media_id = $1 AND target = 'youtube' AND status IN ('success','draft','synced')`
    ).get(row.id);
    if (existing) continue;

    const candidateTitle = toYouTubeTitle(row.caption);
    const normCandidate = normalizeTitle(candidateTitle);
    if (!normCandidate) continue;

    let best = null;
    for (const video of uploads) {
      const score = similarity(normCandidate, normalizeTitle(video.title));
      if (!best || score > best.score) best = { ...video, score };
    }
    if (!best || best.score < threshold) continue;

    const info = await db.prepare(`
      INSERT INTO post_log (workflow_id, ig_media_id, target, status, remote_id, remote_url, error, created_at)
      VALUES (NULL, $1, 'youtube', 'synced', $2, $3, $4, $5)
      RETURNING id
    `).run(
      row.id,
      best.id,
      best.id ? `https://youtube.com/watch?v=${best.id}` : null,
      `Synced from YouTube channel — matches "${best.title}" (similarity ${(best.score * 100).toFixed(0)}%)`,
      Date.now()
    );

    synced.push({
      igMediaId: row.id,
      remoteId: best.id,
      remoteTitle: best.title,
      score: best.score,
      postLogId: info.lastInsertRowid
    });
  }

  return { checked: rows.length, channelVideoCount: uploads.length, matched: synced.length, synced };
}

module.exports = {
  authUrl,
  exchangeCodeForToken,
  uploadShort,
  fetchChannelUploads,
  findLikelyDuplicate,
  syncChannelUploads,
  isConnected: async () => !!(await getToken('youtube'))
};
