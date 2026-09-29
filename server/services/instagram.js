const axios = require('axios');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { pipeline } = require('stream/promises');
const db = require('../db');
const { getToken, saveToken } = require('../db/tokens');
const { parseCaption } = require('./caption');

const GRAPH = 'https://graph.facebook.com/v20.0';

// Vercel's serverless functions have no persistent local disk — anything written to the
// filesystem exists only for the lifetime of the current invocation (and isn't guaranteed to
// survive even within it, across a cold start). os.tmpdir() is the one writable location
// guaranteed to exist in that environment, so every download below goes there instead of the
// old data/media/ directory, and nothing about the resulting path is ever persisted to the DB
// for reuse on a later invocation (see the removed `local_path` caching in ensureLocalMedia()).
const MEDIA_DIR = os.tmpdir();

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

  await saveToken('instagram', {
    access_token: pageWithIg.access_token, // page access token, used for IG Graph calls
    expires_at: null,
    meta: { ig_business_account_id: pageWithIg.instagram_business_account.id, page_id: pageWithIg.id }
  });

  return pageWithIg.instagram_business_account.id;
}

async function getCreds() {
  // Allow a directly-pasted long-lived token + business account id as a shortcut (skips OAuth).
  if (process.env.IG_ACCESS_TOKEN && process.env.IG_BUSINESS_ACCOUNT_ID) {
    return { access_token: process.env.IG_ACCESS_TOKEN, ig_business_account_id: process.env.IG_BUSINESS_ACCOUNT_ID };
  }
  const tok = await getToken('instagram');
  if (!tok) return null;
  return { access_token: tok.access_token, ig_business_account_id: tok.meta.ig_business_account_id };
}

// Instagram's Graph API /media edge silently caps how many items it will return in a single
// page, regardless of what `limit` is requested — passing something like limit:1000 straight
// through gets rejected outright with "Please reduce the amount of data you're asking for, then
// retry your request" (error code 1) rather than being clamped automatically. 100 is the
// documented practical ceiling for this edge as of this writing; kept comfortably under that.
// The `limit` param this function accepts is NOT this per-page size — it's the total number of
// items the CALLER wants across as many pages as it takes to gather them (or fewer, if paging
// runs out first). Pagination itself already uses Graph's own `paging.next` cursor URLs, which is
// the correct mechanism here — Graph's cursor-based paging serves the same purpose an
// offset/limit scheme would, so there's no separate offset param to add on top of it.
const GRAPH_PAGE_SIZE = 100;

/**
 * Fetch historical media, optionally bounded to a date range.
 * sinceDate/untilDate: 'YYYY-MM-DD' strings (inclusive), or null for no bound on that end.
 * limit: total number of items to collect across all pages (NOT a single request's page size —
 * see GRAPH_PAGE_SIZE above). Pass a large number (or Infinity) together with sinceDate/untilDate
 * to page through as much history as needed for that date range.
 *
 * Instagram's /media edge returns items newest-first but doesn't reliably support since/until
 * query params across API versions for this specific edge, so date bounding is done by walking
 * pages and stopping as soon as we pass sinceDate (everything after that page is even older) —
 * this still avoids pulling the whole history when a narrow recent range is requested, since it
 * stops paginating as soon as it's known nothing further back can match.
 */
async function fetchHistoricalMedia({ limit = 50, sinceDate = null, untilDate = null } = {}) {
  const creds = await getCreds();
  if (!creds) throw new Error('Instagram not connected yet.');

  const sinceTs = sinceDate ? new Date(sinceDate + 'T00:00:00Z').getTime() : null;
  // Inclusive end of day for untilDate.
  const untilTs = untilDate ? new Date(untilDate + 'T23:59:59.999Z').getTime() : null;

  // CAROUSEL_ALBUM posts don't expose media_url at the top level — children{media_url,media_type}
  // returns each slide; we use the first slide as the representative media for that post.
  // media_product_type is stored so the app can recognize Reels up front — confirmed (via raw
  // API response) that Instagram never returns media_url for media_product_type REELS, regardless
  // of how recent the post is, so this needs to be flagged rather than discovered per-download.
  const fields = 'id,caption,media_type,media_product_type,media_url,thumbnail_url,permalink,timestamp,children{media_url,media_type}';
  let url = `${GRAPH}/${creds.ig_business_account_id}/media`;
  // Every request's page size is capped at GRAPH_PAGE_SIZE regardless of the caller's overall
  // `limit` — Graph API rejects an oversized single-page request rather than clamping it itself.
  let params = { access_token: creds.access_token, fields, limit: Math.min(limit, GRAPH_PAGE_SIZE) };
  const results = [];
  let stoppedEarly = false;

  while (url) {
    let data;
    try {
      ({ data } = await axios.get(url, { params }));
    } catch (err) {
      const apiErr = err.response?.data?.error;
      if (apiErr) {
        throw new Error(`Instagram API error fetching media: ${apiErr.message || apiErr.type || 'unknown error'} (code ${apiErr.code ?? '?'})`);
      }
      throw err;
    }
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
      // paging.next is a full URL that already encodes its own `limit` (Graph's own next-page
      // sizing) — reuse it as-is and drop our local `params`, exactly as before. This is what
      // makes multi-page fetches work for a large `limit`/date range: each subsequent request
      // stays within Graph's own page-size cap automatically, since Graph generated the URL.
      url = data.paging.next;
      params = undefined;
    }
  }

  const insert = db.prepare(`
    INSERT INTO ig_media (id, media_type, media_product_type, media_url, first_slide_type, permalink, caption, hashtags, timestamp, thumbnail_url, fetched_at)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
    ON CONFLICT(id) DO UPDATE SET
      media_type=excluded.media_type, media_product_type=excluded.media_product_type, media_url=excluded.media_url,
      first_slide_type=excluded.first_slide_type, permalink=excluded.permalink, caption=excluded.caption,
      hashtags=excluded.hashtags, timestamp=excluded.timestamp,
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

    await insert.run(
      item.id,
      item.media_type, // preserve the original IG type for display/filtering
      item.media_product_type || null,
      mediaUrl,
      firstSlideType,
      item.permalink || null,
      item.caption || '',
      JSON.stringify(hashtags),
      item.timestamp || null,
      item.thumbnail_url || null,
      Date.now()
    );
  }

  return await listStoredMedia();
}

async function listStoredMedia() {
  const rows = await db.prepare(`SELECT * FROM ig_media ORDER BY timestamp DESC`).all();
  return rows.map(r => ({ ...r, hashtags: JSON.parse(r.hashtags || '[]') }));
}

/** True if this stored post's actual downloadable media is a video (handles carousels correctly). */
function isVideoMedia(row) {
  if (row.media_type === 'VIDEO' || row.media_type === 'REELS') return true;
  if (row.media_type === 'CAROUSEL_ALBUM') return row.first_slide_type === 'VIDEO';
  return false;
}

/**
 * True if this post is a Reel (media_product_type REELS). Confirmed via raw Graph API response
 * that Instagram never returns media_url for these, regardless of post age — so this should be
 * checked up front to skip fast with a clear message, rather than wasting a refresh attempt.
 */
function isReel(row) {
  return row.media_product_type === 'REELS';
}

/** Message shown when a post is a Reel and the yt-dlp helper service couldn't fetch it. */
function reelNoMediaMessage(mediaId, permalink, reason) {
  return (
    `This is an Instagram Reel — Instagram's Graph API never returns a downloadable media_url ` +
    `for Reels via this field, regardless of how recent the post is. This app tries to fall back ` +
    `to downloading the Reel via the yt-dlp helper service, but that failed: ${reason}. Check ` +
    `that YTDLP_HELPER_URL/YTDLP_HELPER_SECRET are set correctly and that the helper service is ` +
    `reachable — see SETUP-MIGRATION.md. (Post: ${permalink || `id ${mediaId}`})`
  );
}

/**
 * Fallback for Reels, whose video Instagram's official Graph API never exposes (confirmed — see
 * isReel/refreshMediaUrl).
 *
 * yt-dlp CANNOT run inside a Vercel serverless function (no room/permission for the process, and
 * even if it could, cold starts make repeatedly shelling out to a Python tool impractical). That
 * work has been moved to a separate always-on helper service running on a VPS (built
 * separately — not part of this codebase) which:
 *   1. Receives { permalink } here over HTTPS,
 *   2. Runs yt-dlp itself against Instagram's public web page for that permalink,
 *   3. Uploads the resulting video to Vercel Blob,
 *   4. Returns { blobUrl } pointing at that (public, directly-fetchable) upload.
 * This function is the HTTP CLIENT side of that handoff: it calls the helper, then downloads the
 * blob URL exactly like any other remote media URL. The three failure modes below are kept
 * distinct (matching the clarity of the old direct-spawn error handling) since they point at
 * different things to check: the helper service itself being down/misconfigured, the helper
 * reporting a yt-dlp-side failure (e.g. private/deleted post), or the returned Blob URL failing
 * to download afterward.
 */
async function downloadReelViaHelper(permalink, destPath) {
  if (!permalink) throw new Error('no permalink available for this post');

  // permalink comes from Instagram's own API response and is normally trustworthy, but as a
  // defense-in-depth guard (e.g. against a corrupted DB row, or a manually-edited value), refuse
  // to send the helper anything other than a real instagram.com URL.
  if (!/^https:\/\/(www\.)?instagram\.com\//i.test(permalink)) {
    throw new Error(`refusing to send an unexpected URL to the yt-dlp helper: ${permalink}`);
  }

  const helperUrl = process.env.YTDLP_HELPER_URL;
  const helperSecret = process.env.YTDLP_HELPER_SECRET;
  if (!helperUrl) {
    throw new Error(
      'YTDLP_HELPER_URL is not set — this app can no longer run yt-dlp directly (Vercel\'s ' +
      'serverless functions can\'t spawn it). Point YTDLP_HELPER_URL at the yt-dlp helper ' +
      'service\'s /download endpoint (see SETUP-MIGRATION.md).'
    );
  }

  let blobUrl;
  try {
    const { data } = await axios.post(
      helperUrl,
      { permalink },
      {
        headers: helperSecret ? { Authorization: `Bearer ${helperSecret}` } : undefined,
        timeout: 120000
      }
    );
    blobUrl = data?.blobUrl;
    if (!blobUrl) {
      throw new Error('helper responded successfully but did not include a blobUrl');
    }
  } catch (err) {
    if (err.response) {
      // Helper reached, but it reported a failure (e.g. yt-dlp itself failed against this
      // permalink — private/deleted post, Instagram-side change, etc).
      const body = err.response.data;
      const msg = (body && (body.error || body.message)) || JSON.stringify(body).slice(0, 500);
      throw new Error(`yt-dlp helper returned an error (status ${err.response.status}): ${msg}`);
    }
    if (err.request) {
      // Request went out but no response came back — helper is down, unreachable, or timed out.
      throw new Error(`yt-dlp helper is unreachable at ${helperUrl}: ${err.message}`);
    }
    // Anything else, including the "no blobUrl" throw above.
    throw new Error(`yt-dlp helper call failed: ${err.message}`);
  }

  try {
    const resp = await axios.get(blobUrl, { responseType: 'stream' });
    await pipeline(resp.data, fs.createWriteStream(destPath));
  } catch (err) {
    throw new Error(`Downloaded blobUrl from yt-dlp helper but failed to fetch it: ${err.message} (url: ${blobUrl})`);
  }

  return destPath;
}

/**
 * Re-fetch a single post's media_url (and children, for carousels) fresh from the Graph API
 * and update the stored row. Instagram's CDN URLs are signed and expire after a few hours, so
 * anything that needs a live media_url (downloading, or handing the URL to a third-party API
 * like TikTok's PULL_FROM_URL) should call this first rather than trusting whatever was stored
 * at the last /media/fetch. Returns the updated row.
 */
async function refreshMediaUrl(mediaId) {
  const creds = await getCreds();
  if (!creds) throw new Error('Instagram not connected yet.');

  const fields = 'id,media_type,media_product_type,media_url,permalink,children{media_url,media_type}';
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

  // A 200 response can still be an error envelope in rare cases, or simply lack media_url.
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

  await db.prepare(`UPDATE ig_media SET media_url = $1, media_product_type = $2, first_slide_type = $3 WHERE id = $4`)
    .run(mediaUrl, item.media_product_type || null, firstSlideType, mediaId);

  return await db.prepare(`SELECT * FROM ig_media WHERE id = $1`).get(mediaId);
}

/**
 * Message shown when Instagram's Graph API returns no media_url for a non-Reel post — a
 * genuinely empty field with the request itself succeeding, and not something re-fetching or
 * refreshing fixes. Distinct from reelNoMediaMessage() since Reels are a confirmed, permanent
 * API gap, whereas this covers rarer cases (e.g. a deleted/archived post) that may vary.
 */
function noMediaUrlMessage(mediaId, permalink) {
  return (
    `Instagram's API returned no direct media link for this post, even though the request ` +
    `succeeded. This can happen if the post was deleted or archived on Instagram's side. There's ` +
    `no automatic recovery for this case — the post (${permalink || `id ${mediaId}`}) can't be ` +
    `reposted through this app until Instagram's API returns a media_url for it again.`
  );
}

/**
 * Downloads the post's media file to a temp path and returns it. NOT cached/persisted: Vercel's
 * serverless functions have no durable local disk, so every call re-downloads from scratch into
 * os.tmpdir() and the resulting path is only valid for the remainder of THIS invocation. This is
 * fine because ensureLocalMedia() is only ever called once per repostOne() call (see
 * server/services/workflow.js) — there is no second call within the same invocation that could
 * benefit from a same-invocation cache, so the old `local_path` DB column is no longer written
 * or read here at all (it can never be valid across invocations on Vercel, and isn't needed
 * within one either).
 *
 * A random suffix is included in the filename since multiple concurrent invocations (or
 * concurrent repostOne calls within one invocation, e.g. a multi-post workflow run) could
 * otherwise collide on the same os.tmpdir(), which is shared per-container rather than
 * per-request.
 */
async function ensureLocalMedia(mediaId) {
  let row = await db.prepare(`SELECT * FROM ig_media WHERE id = $1`).get(mediaId);
  if (!row) throw new Error('Unknown IG media id: ' + mediaId);

  const uniqueSuffix = crypto.randomBytes(4).toString('hex');

  // Confirmed: Instagram never returns media_url for Reels via the Graph API, at any age.
  // Fall back to the yt-dlp helper service against the post's public permalink.
  if (isReel(row)) {
    const dest = path.join(MEDIA_DIR, `${mediaId}-${uniqueSuffix}.mp4`);
    try {
      await downloadReelViaHelper(row.permalink, dest);
    } catch (err) {
      throw new Error(reelNoMediaMessage(mediaId, row.permalink, err.message));
    }
    return dest;
  }

  // Stored media_url may be hours old and already expired (403) — refresh it first rather
  // than waiting to fail and asking the user to re-fetch the whole library.
  row = await refreshMediaUrl(mediaId);
  if (!row.media_url) throw new Error(noMediaUrlMessage(mediaId, row.permalink));

  const ext = isVideoMedia(row) ? 'mp4' : 'jpg';
  const dest = path.join(MEDIA_DIR, `${mediaId}-${uniqueSuffix}.${ext}`);
  const resp = await axios.get(row.media_url, { responseType: 'stream' });
  await pipeline(resp.data, fs.createWriteStream(dest));

  return dest;
}

/**
 * Returns a guaranteed-fresh media_url for this post (refreshing from the Graph API first).
 * Used only for TikTok's PULL_FROM_URL photo posting, which needs a real remote URL that
 * TikTok's servers fetch themselves — a locally yt-dlp'd file can't substitute here (unlike
 * ensureLocalMedia's YouTube/TikTok-video paths, which upload a local file directly), so Reels
 * genuinely have no path to TikTok photo posting; this doesn't apply to Reels anyway since
 * they're videos, not photos, but kept strict for clarity if ever called on one.
 */
async function getFreshMediaUrl(mediaId) {
  let row = await db.prepare(`SELECT * FROM ig_media WHERE id = $1`).get(mediaId);
  if (!row) throw new Error('Unknown IG media id: ' + mediaId);
  if (isReel(row)) {
    throw new Error(
      `This is an Instagram Reel — Instagram never exposes a direct media_url for Reels, and ` +
      `this function needs a live remote URL (not a local file), so the yt-dlp fallback used ` +
      `elsewhere for Reels can't help here.`
    );
  }

  row = await refreshMediaUrl(mediaId);
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
  isReel,
  refreshMediaUrl,
  getFreshMediaUrl,
  isConnected: async () => !!(await getCreds())
};
