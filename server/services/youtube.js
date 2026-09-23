const fs = require('fs');
const { google } = require('googleapis');
const { getToken, saveToken } = require('../db/tokens');

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
    // Google's `prompt` param only reliably honors a single value in practice — passing
    // "consent select_account" together gets silently collapsed to just consent, and the
    // account chooser never appears. select_account is what actually forces Google to show
    // the "choose an account" screen every time, letting you pick a different Google account
    // than whichever is currently signed in by default. (A refresh token is still issued on
    // first connect per account, so this doesn't require re-adding consent separately.)
    prompt: 'select_account',
    scope: ['https://www.googleapis.com/auth/youtube.upload', 'https://www.googleapis.com/auth/youtube']
  });
}

async function exchangeCodeForToken(code) {
  const client = oauthClient();
  const { tokens } = await client.getToken(code);
  saveToken('youtube', {
    access_token: tokens.access_token,
    refresh_token: tokens.refresh_token,
    expires_at: tokens.expiry_date || null
  });
  return tokens;
}

async function getAuthedClient() {
  const tok = getToken('youtube');
  if (!tok) throw new Error('YouTube not connected yet.');
  const client = oauthClient();
  client.setCredentials({ access_token: tok.access_token, refresh_token: tok.refresh_token });
  client.on('tokens', (t) => {
    saveToken('youtube', {
      access_token: t.access_token || tok.access_token,
      refresh_token: t.refresh_token || tok.refresh_token,
      expires_at: t.expiry_date || tok.expires_at
    });
  });
  return client;
}

/**
 * Upload a video as a YouTube Short.
 * privacyStatus: 'public' | 'unlisted' | 'private'
 */
async function uploadShort({ filePath, title, description, tags = [], privacyStatus = 'public' }) {
  const auth = await getAuthedClient();
  const youtube = google.youtube({ version: 'v3', auth });

  const res = await youtube.videos.insert({
    part: ['snippet', 'status'],
    requestBody: {
      snippet: { title, description, tags, categoryId: '22' },
      status: { privacyStatus, selfDeclaredMadeForKids: false }
    },
    media: { body: fs.createReadStream(filePath) }
  });

  const videoId = res.data.id;
  return { id: videoId, url: `https://youtube.com/shorts/${videoId}` };
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

module.exports = {
  authUrl,
  exchangeCodeForToken,
  uploadShort,
  fetchChannelUploads,
  findLikelyDuplicate,
  isConnected: () => !!getToken('youtube')
};
