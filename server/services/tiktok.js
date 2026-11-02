const fs = require('fs');
const path = require('path');
const axios = require('axios');
const crypto = require('crypto');
const { google } = require('googleapis');

const PM3K_API_BASE = process.env.PM3K_BASE_URL || 'https://pm3k.org/api/v2';

/**
 * Authenticate with Google Drive using either service account credentials,
 * an OAuth2 refresh token, or default application credentials.
 */
function getGoogleDriveAuth() {
  if (process.env.GOOGLE_SERVICE_ACCOUNT_JSON) {
    try {
      const credentials = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON);
      return new google.auth.GoogleAuth({
        credentials,
        scopes: ['https://www.googleapis.com/auth/drive.file']
      });
    } catch (err) {
      console.error('[tiktok/drive] Failed parsing GOOGLE_SERVICE_ACCOUNT_JSON:', err.message);
    }
  }

  if (process.env.GOOGLE_DRIVE_REFRESH_TOKEN) {
    const oauth2Client = new google.auth.OAuth2(
      process.env.GOOGLE_DRIVE_CLIENT_ID || process.env.YT_CLIENT_ID,
      process.env.GOOGLE_DRIVE_CLIENT_SECRET || process.env.YT_CLIENT_SECRET
    );
    oauth2Client.setCredentials({
      refresh_token: process.env.GOOGLE_DRIVE_REFRESH_TOKEN
    });
    return oauth2Client;
  }

  return new google.auth.GoogleAuth({
    scopes: ['https://www.googleapis.com/auth/drive.file']
  });
}

/**
 * Uploads a local file to Google Drive and sets public read permissions.
 * Returns a shareable drive link compatible with PM3K.
 */
async function uploadToGoogleDrive(filePath) {
  const auth = getGoogleDriveAuth();
  const drive = google.drive({ version: 'v3', auth });

  const requestBody = {
    name: path.basename(filePath)
  };
  if (process.env.GOOGLE_DRIVE_FOLDER_ID) {
    requestBody.parents = [process.env.GOOGLE_DRIVE_FOLDER_ID];
  }

  let res;
  try {
    res = await drive.files.create({
      supportsAllDrives: true,
      requestBody,
      media: {
        mimeType: 'video/mp4',
        body: fs.createReadStream(filePath)
      },
      fields: 'id, webViewLink'
    });
  } catch (err) {
    const isInvalidGrant = err?.response?.data?.error === 'invalid_grant' || /invalid_grant/i.test(err?.message);
    if (isInvalidGrant) {
      throw new Error(
        'Google Drive authentication failed (invalid_grant: refresh token expired or revoked). ' +
        'Check GOOGLE_DRIVE_REFRESH_TOKEN and ensure your Google Cloud OAuth app is set to "In production" ' +
        'rather than "Testing" to avoid 7-day token expiration.'
      );
    }
    throw new Error(`Google Drive upload failed: ${err.message}`);
  }

  const fileId = res.data.id;
  if (!fileId) throw new Error('Google Drive upload succeeded but returned no file id.');

  // Set public view permissions so PM3K can download the media file
  try {
    await drive.permissions.create({
      fileId,
      supportsAllDrives: true,
      requestBody: {
        role: 'reader',
        type: 'anyone'
      }
    });
  } catch (err) {
    console.warn(`[tiktok/drive] Failed setting public permissions on ${fileId}:`, err.message);
  }

  return `https://drive.google.com/file/d/${fileId}/view?usp=drive_link`;
}

/**
 * Fetches batch processing status from PM3K API.
 */
async function getBatchStatus(batchId) {
  const apiKey = process.env.PM3K_API_KEY || 'pm3k_v2';
  const res = await axios.get(`${PM3K_API_BASE}/tiktok/posts/batches/${batchId}`, {
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json'
    }
  });
  return res.data;
}

/** Create one PM3K batch with a single item and normalise the result. */
async function createBatch({ media, caption, privacyLevel }) {
  const apiKey = process.env.PM3K_API_KEY || 'pm3k_v2';
  const accountId = process.env.PM3K_TIKTOK_ACCOUNT_ID;
  if (!accountId) throw new Error('PM3K_TIKTOK_ACCOUNT_ID is required to post to TikTok via PM3K.');

  const idempotencyKey = `pm3k-${crypto.randomBytes(8).toString('hex')}`;
  const payload = {
    idempotency_key: idempotencyKey,
    items: [
      {
        account_id: accountId,
        media,
        post_info: {
          title: caption.slice(0, 2200),
          privacy: privacyLevel,
          audio_rights_confirmed: true
        }
      }
    ]
  };

  const res = await axios.post(`${PM3K_API_BASE}/tiktok/posts/batches`, payload, {
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' }
  });

  const batchId = res.data?.id || res.data?.batch_id || (res.data?.data && (res.data.data.id || res.data.data.batch_id)) || idempotencyKey;
  return {
    publish_id: batchId,
    batch_id: batchId,
    source_url: media.source_url,
    privacy_used: privacyLevel,
    draft: false,
    data: res.data
  };
}

/**
 * Post a video to TikTok via PM3K batches API.
 * 1. Uploads file to Google Drive to obtain a public view link.
 * 2. Creates a batch post via POST https://pm3k.org/api/v2/tiktok/posts/batches.
 */
async function postVideo({ filePath, caption, privacyLevel = 'PUBLIC_TO_EVERYONE' }) {
  const sourceUrl = await uploadToGoogleDrive(filePath);
  return createBatch({ media: { source_url: sourceUrl, media_type: 'VIDEO' }, caption, privacyLevel });
}

/**
 * Post a single image to TikTok via the same PM3K batches endpoint.
 * imageUrl must be publicly fetchable (the caller refreshes the signed Instagram URL first).
 * ASSUMPTION: PM3K accepts media_type "PHOTO" with a source_url, mirroring the VIDEO item. This is not
 * confirmed in PM3K's docs; if it rejects the post, set PM3K_PHOTO_MEDIA_TYPE to the value it expects.
 */
async function postPhoto({ imageUrl, caption, privacyLevel = 'PUBLIC_TO_EVERYONE' }) {
  if (!imageUrl) throw new Error('postPhoto requires imageUrl.');
  if (!/^https:\/\//i.test(imageUrl)) throw new Error('postPhoto requires an https imageUrl.');
  const mediaType = process.env.PM3K_PHOTO_MEDIA_TYPE || 'PHOTO';
  return createBatch({ media: { source_url: imageUrl, media_type: mediaType }, caption, privacyLevel });
}

module.exports = {
  postVideo,
  postPhoto,
  getBatchStatus,
  uploadToGoogleDrive,
  isConnected: async () => !!(process.env.PM3K_API_KEY && process.env.PM3K_TIKTOK_ACCOUNT_ID),
};
