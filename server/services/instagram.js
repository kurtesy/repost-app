const axios = require('axios');
const fs = require('fs');
const path = require('path');
const { pipeline } = require('stream/promises');
const db = require('../db');
const { getToken, saveToken } = require('../db/tokens');
const { parseCaption } = require('./caption');

const GRAPH = 'https://graph.facebook.com/v20.0';
const MEDIA_DIR = path.join(__dirname, '..', '..', 'data', 'media');
if (!fs.existsSync(MEDIA_DIR)) fs.mkdirSync(MEDIA_DIR, { recursive: true });

function authUrl() {
  const appId = process.env.IG_APP_ID;
  const redirect = process.env.IG_REDIRECT_URI;
  // Scopes for the "Facebook Login for Business" flow (facebook.com/dialog/oauth), used to read
  // a Page-linked Instagram Business Account's media. instagram_basic is NOT deprecated in this
  // context — only the separate, now-dead Instagram Basic Display API used that name and was shut
  // down Dec 2024. (instagram_business_basic/instagram_business_content_publish are a different,
  // parallel scope set that only applies to the newer "Instagram API with Instagram Login" product's
  // own OAuth endpoint at instagram.com/oauth/authorize — using them here throws "Invalid Scopes.")
  // This app only reads Instagram media (never publishes back), so instagram_content_publish is
  // intentionally omitted — keeping requested scopes limited to what's used speeds up App Review.
  const scope = [
    'instagram_basic',
    'pages_show_list',
    'pages_read_engagement',
    'pages_read_user_content',
    'business_management'
  ].join(',');
  return `https://www.facebook.com/v20.0/dialog/oauth?client_id=${appId}&redirect_uri=${encodeURIComponent(redirect)}&scope=${encodeURIComponent(scope)}&response_type=code`;
}

async function exchangeCodeForToken(code) {
  const { data } = await axios.get(`${GRAPH}/oauth/access_token`, {
    params: {
      client_id: process.env.IG_APP_ID,
      client_secret: process.env.IG_APP_SECRET,
      redirect_uri: process.env.IG_REDIRECT_URI,
      code
    }
  });
  // Exchange short-lived user token for a long-lived one (~60 days)
  const { data: longLived } = await axios.get(`${GRAPH}/oauth/access_token`, {
    params: {
      grant_type: 'fb_exchange_token',
      client_id: process.env.IG_APP_ID,
      client_secret: process.env.IG_APP_SECRET,
      fb_exchange_token: data.access_token
    }
  });

  const userToken = longLived.access_token;

  // Find the Page -> connected IG Business Account
  const { data: pages } = await axios.get(`${GRAPH}/me/accounts`, {
    params: { access_token: userToken, fields: 'id,name,access_token,instagram_business_account' }
  });
  const pageWithIg = (pages.data || []).find(p => p.instagram_business_account);
  if (!pageWithIg) {
    throw new Error('No Facebook Page with a connected Instagram Business/Creator account was found.');
  }

  saveToken('instagram', {
    access_token: pageWithIg.access_token, // page access token, used for IG Graph calls
    expires_at: null,
    meta: { ig_business_account_id: pageWithIg.instagram_business_account.id, page_id: pageWithIg.id }
  });

  return pageWithIg.instagram_business_account.id;
}

function getCreds() {
  // Allow a directly-pasted long-lived token + business account id as a shortcut (skips OAuth).
  if (process.env.IG_ACCESS_TOKEN && process.env.IG_BUSINESS_ACCOUNT_ID) {
    return { access_token: process.env.IG_ACCESS_TOKEN, ig_business_account_id: process.env.IG_BUSINESS_ACCOUNT_ID };
  }
  const tok = getToken('instagram');
  if (!tok) return null;
  return { access_token: tok.access_token, ig_business_account_id: tok.meta.ig_business_account_id };
}

/**
 * Fetch historical media, optionally bounded to a date range.
 * sinceDate/untilDate: 'YYYY-MM-DD' strings (inclusive), or null for no bound on that end.
 *
 * Instagram's /media edge returns items newest-first but doesn't reliably support since/until
 * query params across API versions for this specific edge, so date bounding is done by walking
 * pages and stopping as soon as we pass sinceDate (everything after that page is even older) —
 * this still avoids pulling the whole history when a narrow recent range is requested, since it
 * stops paginating as soon as it's known nothing further back can match.
 */
async function fetchHistoricalMedia({ limit = 50, sinceDate = null, untilDate = null } = {}) {
  const creds = getCreds();
  if (!creds) throw new Error('Instagram not connected yet.');

  const sinceTs = sinceDate ? new Date(sinceDate + 'T00:00:00Z').getTime() : null;
  // Inclusive end of day for untilDate.
  const untilTs = untilDate ? new Date(untilDate + 'T23:59:59.999Z').getTime() : null;

  // CAROUSEL_ALBUM posts don't expose media_url at the top level — children{media_url,media_type}
  // returns each slide; we use the first slide as the representative media for that post.
  const fields = 'id,caption,media_type,media_url,thumbnail_url,permalink,timestamp,children{media_url,media_type}';
  let url = `${GRAPH}/${creds.ig_business_account_id}/media`;
  let params = { access_token: creds.access_token, fields, limit };
  const results = [];
  let stoppedEarly = false;

  while (url) {
    const { data } = await axios.get(url, { params });
    const page = data.data || [];

    for (const item of page) {
      const ts = item.timestamp ? new Date(item.timestamp).getTime() : null;
      if (sinceTs !== null && ts !== null && ts < sinceTs) {
        // Items are newest-first, so once we're older than sinceDate everything remaining
        // (this page's tail and all further pages) is older too — safe to stop entirely.
        stoppedEarly = true;
        break;
      }
      if (untilTs !== null && ts !== null && ts > untilTs) {
        // Newer than the requested range — skip this item but keep paginating, since
        // (rarely) a mixed page could still contain in-range items further down.
        continue;
      }
      results.push(item);
    }

    const noDateBoundLimitReached = sinceTs === null && untilTs === null && results.length >= limit;
    if (stoppedEarly || noDateBoundLimitReached || !data.paging?.next) {
      url = null;
    } else {
      url = data.paging.next;
      params = undefined;
    }
  }

  const insert = db.prepare(`
    INSERT INTO ig_media (id, media_type, media_url, first_slide_type, permalink, caption, hashtags, timestamp, thumbnail_url, fetched_at)
    VALUES (@id, @media_type, @media_url, @first_slide_type, @permalink, @caption, @hashtags, @timestamp, @thumbnail_url, @fetched_at)
    ON CONFLICT(id) DO UPDATE SET
      media_type=excluded.media_type, media_url=excluded.media_url, first_slide_type=excluded.first_slide_type,
      permalink=excluded.permalink, caption=excluded.caption, hashtags=excluded.hashtags, timestamp=excluded.timestamp,
      thumbnail_url=excluded.thumbnail_url, fetched_at=excluded.fetched_at
  `);

  for (const item of results) {
    // Store everything (VIDEO, REELS, IMAGE, CAROUSEL_ALBUM) — the dashboard filters by type,
    // and workflows decide per-platform what's postable (e.g. YouTube can't accept images).
    const { hashtags } = parseCaption(item.caption);

    // CAROUSEL_ALBUM has no top-level media_url — use its first slide as the representative media.
    // first_slide_type is stored separately so downloads/posting know whether that slide is itself
    // a video or an image, since a carousel's first item can be either.
    let mediaUrl = item.media_url || null;
    let firstSlideType = item.media_type === 'VIDEO' || item.media_type === 'REELS' ? 'VIDEO' : 'IMAGE';
    if (item.media_type === 'CAROUSEL_ALBUM' && item.children?.data?.length) {
      const firstSlide = item.children.data[0];
      mediaUrl = firstSlide.media_url || null;
      firstSlideType = firstSlide.media_type === 'VIDEO' ? 'VIDEO' : 'IMAGE';
    }

    insert.run({
      id: item.id,
      media_type: item.media_type, // preserve the original IG type for display/filtering
      media_url: mediaUrl,
      first_slide_type: firstSlideType,
      permalink: item.permalink || null,
      caption: item.caption || '',
      hashtags: JSON.stringify(hashtags),
      timestamp: item.timestamp || null,
      thumbnail_url: item.thumbnail_url || null,
      fetched_at: Date.now()
    });
  }

  return listStoredMedia();
}

function listStoredMedia() {
  const rows = db.prepare(`SELECT * FROM ig_media ORDER BY timestamp DESC`).all();
  return rows.map(r => ({ ...r, hashtags: JSON.parse(r.hashtags || '[]') }));
}

/** True if this stored post's actual downloadable media is a video (handles carousels correctly). */
function isVideoMedia(row) {
  if (row.media_type === 'VIDEO' || row.media_type === 'REELS') return true;
  if (row.media_type === 'CAROUSEL_ALBUM') return row.first_slide_type === 'VIDEO';
  return false;
}

/**
 * Re-fetch a single post's media_url (and children, for carousels) fresh from the Graph API
 * and update the stored row. Instagram's CDN URLs are signed and expire after a few hours, so
 * anything that needs a live media_url (downloading, or handing the URL to a third-party API
 * like TikTok's PULL_FROM_URL) should call this first rather than trusting whatever was stored
 * at the last /media/fetch. Returns the updated row.
 */
async function refreshMediaUrl(mediaId) {
  const creds = getCreds();
  if (!creds) throw new Error('Instagram not connected yet.');

  const fields = 'id,media_type,media_url,children{media_url,media_type}';
  let item;
  try {
    const { data } = await axios.get(`${GRAPH}/${mediaId}`, {
      params: { access_token: creds.access_token, fields }
    });
    item = data;
  } catch (err) {
    // Graph API errors come back as a JSON body (error.message/code) on a non-2xx status —
    // surface that instead of silently falling through to "No media_url available", which
    // hid the real cause (expired token, permission issue, deleted post, rate limit, etc).
    const apiErr = err.response?.data?.error;
    if (apiErr) {
      throw new Error(`Instagram API error refreshing media ${mediaId}: ${apiErr.message || apiErr.type || 'unknown error'} (code ${apiErr.code ?? '?'})`);
    }
    throw new Error(`Failed to refresh media ${mediaId} from Instagram: ${err.message}`);
  }

  // A 200 response can still be an error envelope in rare cases, or simply lack media_url —
  // e.g. the post was deleted/archived on Instagram, or media_url isn't returned for posts
  // older than ~90 days for some IG API versions/permission tiers. Distinguish that clearly.
  if (item.error) {
    throw new Error(`Instagram API returned an error for media ${mediaId}: ${item.error.message || JSON.stringify(item.error)}`);
  }

  let mediaUrl = item.media_url || null;
  let firstSlideType = item.media_type === 'VIDEO' || item.media_type === 'REELS' ? 'VIDEO' : 'IMAGE';
  if (item.media_type === 'CAROUSEL_ALBUM' && item.children?.data?.length) {
    const firstSlide = item.children.data[0];
    mediaUrl = firstSlide.media_url || null;
    firstSlideType = firstSlide.media_type === 'VIDEO' ? 'VIDEO' : 'IMAGE';
  }

  db.prepare(`UPDATE ig_media SET media_url = ?, first_slide_type = ? WHERE id = ?`)
    .run(mediaUrl, firstSlideType, mediaId);

  return db.prepare(`SELECT * FROM ig_media WHERE id = ?`).get(mediaId);
}

/**
 * Message shown when Instagram's Graph API returns no media_url for a post at all (not an
 * expired-URL 403 — a genuinely empty field). This happens for older posts: Instagram stops
 * serving a direct CDN link via this field once a post passes a certain age, with no error,
 * no workaround via this API, and no way to detect the cutoff other than the field being empty.
 */
function noMediaUrlMessage(mediaId, permalink) {
  return (
    `Instagram no longer provides a direct media link for this post (it's likely too old — ` +
    `the Graph API stops returning media_url after a post ages out, silently). This can't be ` +
    `fixed by re-fetching. To repost it anyway, manually download the video/image from ` +
    `${permalink || `the post (id ${mediaId})`}, save it as data/media/${mediaId}.mp4 (or .jpg for ` +
    `images), and set its local_path in the database to that file — see SETUP.md for the exact steps.`
  );
}

/** Downloads the post's media file locally (video or image) and returns its path. */
async function ensureLocalMedia(mediaId) {
  let row = db.prepare(`SELECT * FROM ig_media WHERE id = ?`).get(mediaId);
  if (!row) throw new Error('Unknown IG media id: ' + mediaId);
  if (row.local_path && fs.existsSync(row.local_path)) return row.local_path;

  // Stored media_url may be hours old and already expired (403) — refresh it first rather
  // than waiting to fail and asking the user to re-fetch the whole library.
  row = await refreshMediaUrl(mediaId);
  if (!row.media_url) throw new Error(noMediaUrlMessage(mediaId, row.permalink));

  const ext = isVideoMedia(row) ? 'mp4' : 'jpg';
  const dest = path.join(MEDIA_DIR, `${mediaId}.${ext}`);
  const resp = await axios.get(row.media_url, { responseType: 'stream' });
  await pipeline(resp.data, fs.createWriteStream(dest));

  db.prepare(`UPDATE ig_media SET local_path = ? WHERE id = ?`).run(dest, mediaId);
  return dest;
}

/** Returns a guaranteed-fresh media_url for this post (refreshing from the Graph API first). */
async function getFreshMediaUrl(mediaId) {
  const row = await refreshMediaUrl(mediaId);
  if (!row.media_url) throw new Error(noMediaUrlMessage(mediaId, row.permalink));
  return row.media_url;
}

// Kept as an alias for backward compatibility with any existing callers/tests.
const ensureLocalVideo = ensureLocalMedia;

module.exports = {
  authUrl,
  exchangeCodeForToken,
  fetchHistoricalMedia,
  listStoredMedia,
  ensureLocalMedia,
  ensureLocalVideo,
  isVideoMedia,
  refreshMediaUrl,
  getFreshMediaUrl,
  isConnected: () => !!getCreds()
};
