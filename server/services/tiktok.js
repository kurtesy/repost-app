const fs = require('fs');
const axios = require('axios');
const crypto = require('crypto');
const { getToken, saveToken } = require('../db/tokens');

const AUTH_BASE = 'https://www.tiktok.com/v2/auth/authorize/';
const TOKEN_URL = 'https://open.tiktokapis.com/v2/oauth/token/';
const API_BASE = 'https://open.tiktokapis.com/v2';

function authUrl() {
  const state = crypto.randomBytes(8).toString('hex');
  const scope = ['user.info.basic', 'video.publish', 'video.upload'].join(',');
  const params = new URLSearchParams({
    client_key: process.env.TT_CLIENT_KEY,
    scope,
    response_type: 'code',
    redirect_uri: process.env.TT_REDIRECT_URI,
    state
  });
  return `${AUTH_BASE}?${params.toString()}`;
}

async function exchangeCodeForToken(code) {
  const { data } = await axios.post(TOKEN_URL,
    new URLSearchParams({
      client_key: process.env.TT_CLIENT_KEY,
      client_secret: process.env.TT_CLIENT_SECRET,
      code,
      grant_type: 'authorization_code',
      redirect_uri: process.env.TT_REDIRECT_URI
    }),
    { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
  );

  saveToken('tiktok', {
    access_token: data.access_token,
    refresh_token: data.refresh_token,
    expires_at: Date.now() + (data.expires_in || 0) * 1000,
    meta: { open_id: data.open_id }
  });
  return data;
}

async function refreshIfNeeded() {
  const tok = getToken('tiktok');
  if (!tok) throw new Error('TikTok not connected yet.');
  if (tok.expires_at && tok.expires_at > Date.now() + 60000) return tok;

  const { data } = await axios.post(TOKEN_URL,
    new URLSearchParams({
      client_key: process.env.TT_CLIENT_KEY,
      client_secret: process.env.TT_CLIENT_SECRET,
      grant_type: 'refresh_token',
      refresh_token: tok.refresh_token
    }),
    { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
  );

  saveToken('tiktok', {
    access_token: data.access_token,
    refresh_token: data.refresh_token || tok.refresh_token,
    expires_at: Date.now() + (data.expires_in || 0) * 1000,
    meta: tok.meta
  });
  return getToken('tiktok');
}

/**
 * Post a video to TikTok using FILE_UPLOAD source.
 * privacyLevel: 'PUBLIC_TO_EVERYONE' | 'MUTUAL_FOLLOW_FRIENDS' | 'SELF_ONLY'
 * Unaudited apps are restricted by TikTok to SELF_ONLY (draft/private) posting —
 * we attempt the requested privacy and fall back to SELF_ONLY on a scope/audit error.
 */
async function postVideo({ filePath, caption, privacyLevel = 'PUBLIC_TO_EVERYONE' }) {
  const tok = await refreshIfNeeded();
  const stat = fs.statSync(filePath);

  async function initUpload(level) {
    return axios.post(`${API_BASE}/post/publish/video/init/`, {
      post_info: {
        title: caption.slice(0, 2200),
        privacy_level: level,
        disable_duet: false,
        disable_comment: false,
        disable_stitch: false
      },
      source_info: {
        source: 'FILE_UPLOAD',
        video_size: stat.size,
        chunk_size: stat.size,
        total_chunk_count: 1
      }
    }, { headers: { Authorization: `Bearer ${tok.access_token}`, 'Content-Type': 'application/json' } });
  }

  let level = privacyLevel;
  let initRes;
  let usedFallback = false;
  try {
    initRes = await initUpload(level);
  } catch (err) {
    const msg = err.response?.data?.error?.message || '';
    const code = err.response?.data?.error?.code || '';
    if (/audit|scope|not_verified|spam_risk/i.test(msg + code)) {
      level = 'SELF_ONLY';
      usedFallback = true;
      initRes = await initUpload(level);
    } else {
      throw err;
    }
  }

  const { publish_id, upload_url } = initRes.data.data;

  await axios.put(upload_url, fs.createReadStream(filePath), {
    headers: {
      'Content-Type': 'video/mp4',
      'Content-Range': `bytes 0-${stat.size - 1}/${stat.size}`
    },
    maxBodyLength: Infinity,
    maxContentLength: Infinity
  });

  return { publish_id, privacy_used: level, draft: usedFallback };
}

/**
 * Post a photo to TikTok. Unlike video, TikTok's photo API has no raw-file-upload path —
 * it only accepts a publicly reachable image URL (source: 'PULL_FROM_URL'), fetched by
 * TikTok's own servers. We pass Instagram's own CDN URL directly rather than re-hosting it
 * ourselves. Note: Instagram's media URLs expire after a period (typically a few hours), so
 * this only works reliably for recently-fetched posts.
 */
async function postPhoto({ imageUrl, caption, privacyLevel = 'PUBLIC_TO_EVERYONE' }) {
  const tok = await refreshIfNeeded();

  async function initPost(level) {
    return axios.post(`${API_BASE}/post/publish/content/init/`, {
      post_info: {
        title: caption.slice(0, 90),
        description: caption.slice(0, 4000),
        privacy_level: level,
        disable_comment: false,
        auto_add_music: true
      },
      source_info: {
        source: 'PULL_FROM_URL',
        photo_cover_index: 0,
        photo_images: [imageUrl]
      },
      post_mode: 'DIRECT_POST',
      media_type: 'PHOTO'
    }, { headers: { Authorization: `Bearer ${tok.access_token}`, 'Content-Type': 'application/json' } });
  }

  let level = privacyLevel;
  let initRes;
  let usedFallback = false;
  try {
    initRes = await initPost(level);
  } catch (err) {
    const msg = err.response?.data?.error?.message || '';
    const code = err.response?.data?.error?.code || '';
    if (/audit|scope|not_verified|spam_risk/i.test(msg + code)) {
      level = 'SELF_ONLY';
      usedFallback = true;
      initRes = await initPost(level);
    } else if (/url_ownership|url not verified|domain/i.test(msg + code)) {
      throw new Error(
        'TikTok rejected the image URL — either it has expired (Instagram CDN links only stay valid for a few hours, ' +
        'so re-fetch this post from Instagram first) or the source domain needs verifying in the TikTok developer portal. ' +
        `Original error: ${msg || code}`
      );
    } else {
      throw err;
    }
  }

  const { publish_id } = initRes.data.data;
  return { publish_id, privacy_used: level, draft: usedFallback };
}

module.exports = {
  authUrl,
  exchangeCodeForToken,
  postVideo,
  postPhoto,
  isConnected: () => !!getToken('tiktok')
};
