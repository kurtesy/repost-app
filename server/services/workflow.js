const fs = require('fs');
const db = require('../db');
const instagram = require('./instagram');
const youtube = require('./youtube');
const tiktok = require('./tiktok');
const {
  toYouTubeTitle, toYouTubeDescription, toYouTubeTags, toTikTokCaption
} = require('./caption');
const { safeErrorMessage } = require('./errors');

/**
 * Best-effort delete of a temp file downloaded by instagram.ensureLocalMedia(). Since that
 * function now always writes into os.tmpdir() (no persistent disk on Vercel — see
 * server/services/instagram.js), cleaning up after the upload avoids accumulating files in a
 * warm container's shared /tmp across many invocations. Failure to delete is logged, not
 * thrown — it must never mask the real result of a repost attempt.
 */
function cleanupTempFile(filePath) {
  if (!filePath) return;
  fs.unlink(filePath, (err) => {
    if (err && err.code !== 'ENOENT') {
      console.warn(`[workflow] failed to clean up temp file ${filePath}:`, err.message);
    }
  });
}

function defaultPrivacyFor(target) {
  return target === 'youtube' ? 'public' : 'PUBLIC_TO_EVERYONE';
}

const VALID_POST_ORDERS = ['newest_first', 'oldest_first'];
const VALID_UPLOAD_AS = ['shorts', 'video'];

async function createWorkflow({ name, target, scheduleCron = null, postsPerRun = 1, privacy, postOrder, uploadAs }) {
  const order = VALID_POST_ORDERS.includes(postOrder) ? postOrder : 'newest_first';
  const uploadAsValue = VALID_UPLOAD_AS.includes(uploadAs) ? uploadAs : 'shorts';
  const stmt = db.prepare(`
    INSERT INTO workflows (name, target, enabled, schedule_cron, posts_per_run, privacy, post_order, upload_as, created_at)
    VALUES ($1, $2, 1, $3, $4, $5, $6, $7, $8)
    RETURNING id
  `);
  const info = await stmt.run(name, target, scheduleCron, postsPerRun, privacy || defaultPrivacyFor(target), order, uploadAsValue, Date.now());
  return await getWorkflow(info.lastInsertRowid);
}

async function getWorkflow(id) {
  return db.prepare(`SELECT * FROM workflows WHERE id = $1`).get(id);
}

async function listWorkflows() {
  return db.prepare(`SELECT * FROM workflows ORDER BY id`).all();
}

async function updateWorkflow(id, fields) {
  const current = await getWorkflow(id);
  if (!current) throw new Error('Workflow not found');
  const merged = { ...current, ...fields };
  if (fields.postOrder !== undefined) {
    merged.post_order = VALID_POST_ORDERS.includes(fields.postOrder) ? fields.postOrder : current.post_order;
  }
  if (fields.uploadAs !== undefined) {
    merged.upload_as = VALID_UPLOAD_AS.includes(fields.uploadAs) ? fields.uploadAs : current.upload_as;
  }
  await db.prepare(`
    UPDATE workflows SET name=$1, target=$2, enabled=$3, schedule_cron=$4, posts_per_run=$5, privacy=$6, post_order=$7, upload_as=$8
    WHERE id=$9
  `).run(merged.name, merged.target, merged.enabled ? 1 : 0, merged.schedule_cron, merged.posts_per_run, merged.privacy, merged.post_order || 'newest_first', merged.upload_as || 'shorts', id);
  return await getWorkflow(id);
}

async function deleteWorkflow(id) {
  await db.prepare(`DELETE FROM workflows WHERE id = $1`).run(id);
}

async function alreadyPosted(igMediaId, target) {
  // 'synced' rows are written by the YouTube channel-sync feature (server/services/youtube.js's
  // syncChannelUploads, via POST /api/sync/youtube) when a video is found already on the real
  // YouTube channel with no matching post_log row — e.g. uploaded manually, or posted by this
  // app before post_log existed / before a DB migration. They must count as "already posted" the
  // same as a real success, or workflows would try to repost something that's already live.
  return db.prepare(`
    SELECT * FROM post_log WHERE ig_media_id = $1 AND target = $2 AND status IN ('success','draft','synced')
  `).get(igMediaId, target);
}

async function logAttempt(row) {
  const info = await db.prepare(`
    INSERT INTO post_log (workflow_id, ig_media_id, target, status, remote_id, remote_url, error, created_at)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
    RETURNING id
  `).run(row.workflow_id, row.ig_media_id, row.target, row.status, row.remote_id, row.remote_url, row.error, row.created_at);
  return info.lastInsertRowid;
}

async function getLog({ limit = 100 } = {}) {
  return db.prepare(`SELECT * FROM post_log ORDER BY id DESC LIMIT $1`).all(limit);
}

/** True if this stored IG post's actual media is a video, false if it's an image (handles carousels). */
function isVideoPost(media) {
  return instagram.isVideoMedia(media);
}

/** Post a single IG media item to the given target platform. */
async function repostOne({ workflowId, igMediaId, target, privacy, uploadAs = 'shorts', skipDuplicateCheck = false }) {
  const media = await db.prepare(`SELECT * FROM ig_media WHERE id = $1`).get(igMediaId);
  if (!media) throw new Error('IG media not found: ' + igMediaId);
  const hashtags = JSON.parse(media.hashtags || '[]');
  const isVideo = isVideoPost(media);

  if (await alreadyPosted(igMediaId, target)) {
    return { skipped: true, reason: 'already posted to ' + target };
  }

  // Reels have no media_url via the Graph API (confirmed, permanent) — ensureLocalMedia()
  // handles this by falling back to yt-dlp against the post's public permalink, so no need to
  // skip here; a Reel simply flows through the normal video download+upload path below, and
  // only fails (with a clear message) if yt-dlp itself isn't installed or the download fails.
  // TikTok photo posting (getFreshMediaUrl) still can't support Reels, but that path is only
  // reached for image posts, which Reels never are.

  // YouTube's API has no way to publish a standalone image post — only video/Shorts uploads
  // exist. Skip rather than fail loudly, since this is a structural limitation, not an error.
  if (target === 'youtube' && !isVideo) {
    await logAttempt({
      workflow_id: workflowId, ig_media_id: igMediaId, target,
      status: 'skipped_unsupported', remote_id: null, remote_url: null,
      error: 'YouTube has no API for posting standalone images — only video/Shorts uploads are supported.',
      created_at: Date.now()
    });
    return { skipped: true, reason: 'YouTube cannot accept image posts' };
  }

  // Beyond this app's own post_log (which only knows about posts made through this app),
  // check the actual YouTube channel for a video that looks like it's already there —
  // catches anything uploaded manually before this app was ever used.
  if (target === 'youtube' && !skipDuplicateCheck) {
    const candidateTitle = toYouTubeTitle(media.caption);
    const dupeCheck = await youtube.findLikelyDuplicate(candidateTitle);
    if (dupeCheck.isDuplicate) {
      await logAttempt({
        workflow_id: workflowId, ig_media_id: igMediaId, target,
        status: 'skipped_duplicate', remote_id: dupeCheck.match.id, remote_url: `https://youtube.com/watch?v=${dupeCheck.match.id}`,
        error: `Matches existing YouTube video "${dupeCheck.match.title}" (similarity ${(dupeCheck.match.score * 100).toFixed(0)}%)`,
        created_at: Date.now()
      });
      return { skipped: true, reason: 'likely already on YouTube channel', match: dupeCheck.match };
    }
  }

  let result;
  try {
    if (target === 'youtube') {
      const filePath = await instagram.ensureLocalMedia(igMediaId);
      try {
        result = await youtube.uploadShort({
          filePath,
          title: toYouTubeTitle(media.caption),
          description: toYouTubeDescription(media.caption, hashtags, uploadAs !== 'video'),
          tags: toYouTubeTags(hashtags),
          privacyStatus: privacy || 'public',
          asShorts: uploadAs !== 'video'
        });
      } finally {
        // Downloaded fresh into os.tmpdir() for this invocation only — see
        // instagram.ensureLocalMedia()'s doc comment. Clean up regardless of upload outcome.
        cleanupTempFile(filePath);
      }
      await logAttempt({
        workflow_id: workflowId, ig_media_id: igMediaId, target,
        status: 'success', remote_id: result.id, remote_url: result.url, error: null, created_at: Date.now()
      });
    } else if (target === 'tiktok' && isVideo) {
      const filePath = await instagram.ensureLocalMedia(igMediaId);
      try {
        result = await tiktok.postVideo({
          filePath,
          caption: toTikTokCaption(media.caption, hashtags),
          privacyLevel: privacy || 'PUBLIC_TO_EVERYONE'
        });
      } finally {
        cleanupTempFile(filePath);
      }
      await logAttempt({
        workflow_id: workflowId, ig_media_id: igMediaId, target,
        status: result.draft ? 'draft' : 'success',
        remote_id: result.publish_id, remote_url: null, error: null, created_at: Date.now()
      });
    } else if (target === 'tiktok' && !isVideo) {
      // TikTok pulls this URL itself (PULL_FROM_URL), so it must be freshly signed —
      // refresh from the Graph API rather than trusting whatever was stored at last fetch.
      const freshImageUrl = await instagram.getFreshMediaUrl(igMediaId);
      result = await tiktok.postPhoto({
        imageUrl: freshImageUrl,
        caption: toTikTokCaption(media.caption, hashtags),
        privacyLevel: privacy || 'PUBLIC_TO_EVERYONE'
      });
      await logAttempt({
        workflow_id: workflowId, ig_media_id: igMediaId, target,
        status: result.draft ? 'draft' : 'success',
        remote_id: result.publish_id, remote_url: null, error: null, created_at: Date.now()
      });
    } else {
      throw new Error('Unknown target: ' + target);
    }
    return { skipped: false, result };
  } catch (err) {
    const errMsg = safeErrorMessage(err);
    await logAttempt({
      workflow_id: workflowId, ig_media_id: igMediaId, target,
      status: 'failed', remote_id: null, remote_url: null, error: errMsg, created_at: Date.now()
    });
    // Re-throw a plain Error with the safe message rather than the original — the original
    // may carry circular Axios internals (sockets/agents) that crash res.json() upstream.
    throw new Error(errMsg);
  }
}

// Tracks workflow ids currently mid-run, to prevent the same workflow from being triggered
// twice concurrently (e.g. "Run now" double-clicked, or a scheduled cron fire overlapping a
// manual run) — without this, both calls would read the same "not yet posted" candidate list
// before either had logged a post_log row, and could post the same IG media twice.
const runningWorkflows = new Set();

/** Run a workflow: pick the next N un-posted IG videos and repost them to its target. */
async function runWorkflow(workflowId, { mediaIds = null } = {}) {
  const wf = await getWorkflow(workflowId);
  if (!wf) throw new Error('Workflow not found');

  if (runningWorkflows.has(workflowId)) {
    throw new Error('This workflow is already running — wait for it to finish before running it again.');
  }
  runningWorkflows.add(workflowId);

  try {
    let candidates;
    if (mediaIds && mediaIds.length) {
      candidates = mediaIds;
    } else {
      // Postgres doesn't allow interpolating ASC/DESC as a bind parameter, but `direction` is
      // built from a fixed internal enum (never user input), so string-interpolating it here is
      // safe and mirrors the original sql.js code's approach.
      const direction = wf.post_order === 'oldest_first' ? 'ASC' : 'DESC';
      const allRows = await db.prepare(`SELECT id FROM ig_media ORDER BY timestamp ${direction}`).all();
      const all = allRows.map(r => r.id);
      const notPosted = [];
      for (const id of all) {
        if (!(await alreadyPosted(id, wf.target))) notPosted.push(id);
      }
      candidates = notPosted.slice(0, wf.posts_per_run);
    }

    const outcomes = [];
    for (const igMediaId of candidates) {
      try {
        const r = await repostOne({ workflowId, igMediaId, target: wf.target, privacy: wf.privacy, uploadAs: wf.upload_as });
        outcomes.push({ igMediaId, ...r });
      } catch (err) {
        outcomes.push({ igMediaId, error: err.message });
      }
    }
    return outcomes;
  } finally {
    runningWorkflows.delete(workflowId);
  }
}

module.exports = {
  createWorkflow, getWorkflow, listWorkflows, updateWorkflow, deleteWorkflow,
  runWorkflow, repostOne, getLog
};
