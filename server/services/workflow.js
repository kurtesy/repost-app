const db = require('../db');
const instagram = require('./instagram');
const youtube = require('./youtube');
const tiktok = require('./tiktok');
const {
  toYouTubeTitle, toYouTubeDescription, toYouTubeTags, toTikTokCaption
} = require('./caption');
const { safeErrorMessage } = require('./errors');

function defaultPrivacyFor(target) {
  return target === 'youtube' ? 'public' : 'PUBLIC_TO_EVERYONE';
}

const VALID_POST_ORDERS = ['newest_first', 'oldest_first'];

function createWorkflow({ name, target, scheduleCron = null, postsPerRun = 1, privacy, postOrder }) {
  const order = VALID_POST_ORDERS.includes(postOrder) ? postOrder : 'newest_first';
  const stmt = db.prepare(`
    INSERT INTO workflows (name, target, enabled, schedule_cron, posts_per_run, privacy, post_order, created_at)
    VALUES (?, ?, 1, ?, ?, ?, ?, ?)
  `);
  const info = stmt.run(name, target, scheduleCron, postsPerRun, privacy || defaultPrivacyFor(target), order, Date.now());
  return getWorkflow(info.lastInsertRowid);
}

function getWorkflow(id) {
  return db.prepare(`SELECT * FROM workflows WHERE id = ?`).get(id);
}

function listWorkflows() {
  return db.prepare(`SELECT * FROM workflows ORDER BY id`).all();
}

function updateWorkflow(id, fields) {
  const current = getWorkflow(id);
  if (!current) throw new Error('Workflow not found');
  const merged = { ...current, ...fields };
  if (fields.postOrder !== undefined) {
    merged.post_order = VALID_POST_ORDERS.includes(fields.postOrder) ? fields.postOrder : current.post_order;
  }
  db.prepare(`
    UPDATE workflows SET name=?, target=?, enabled=?, schedule_cron=?, posts_per_run=?, privacy=?, post_order=?
    WHERE id=?
  `).run(merged.name, merged.target, merged.enabled ? 1 : 0, merged.schedule_cron, merged.posts_per_run, merged.privacy, merged.post_order || 'newest_first', id);
  return getWorkflow(id);
}

function deleteWorkflow(id) {
  db.prepare(`DELETE FROM workflows WHERE id = ?`).run(id);
}

function alreadyPosted(igMediaId, target) {
  return db.prepare(`
    SELECT * FROM post_log WHERE ig_media_id = ? AND target = ? AND status IN ('success','draft')
  `).get(igMediaId, target);
}

function logAttempt(row) {
  const info = db.prepare(`
    INSERT INTO post_log (workflow_id, ig_media_id, target, status, remote_id, remote_url, error, created_at)
    VALUES (@workflow_id, @ig_media_id, @target, @status, @remote_id, @remote_url, @error, @created_at)
  `).run(row);
  return info.lastInsertRowid;
}

function getLog({ limit = 100 } = {}) {
  return db.prepare(`SELECT * FROM post_log ORDER BY id DESC LIMIT ?`).all(limit);
}

/** True if this stored IG post's actual media is a video, false if it's an image (handles carousels). */
function isVideoPost(media) {
  return instagram.isVideoMedia(media);
}

/** Post a single IG media item to the given target platform. */
async function repostOne({ workflowId, igMediaId, target, privacy, skipDuplicateCheck = false }) {
  const media = db.prepare(`SELECT * FROM ig_media WHERE id = ?`).get(igMediaId);
  if (!media) throw new Error('IG media not found: ' + igMediaId);
  const hashtags = JSON.parse(media.hashtags || '[]');
  const isVideo = isVideoPost(media);

  if (alreadyPosted(igMediaId, target)) {
    return { skipped: true, reason: 'already posted to ' + target };
  }

  // YouTube's API has no way to publish a standalone image post — only video/Shorts uploads
  // exist. Skip rather than fail loudly, since this is a structural limitation, not an error.
  if (target === 'youtube' && !isVideo) {
    logAttempt({
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
      logAttempt({
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
      result = await youtube.uploadShort({
        filePath,
        title: toYouTubeTitle(media.caption),
        description: toYouTubeDescription(media.caption, hashtags),
        tags: toYouTubeTags(hashtags),
        privacyStatus: privacy || 'public'
      });
      logAttempt({
        workflow_id: workflowId, ig_media_id: igMediaId, target,
        status: 'success', remote_id: result.id, remote_url: result.url, error: null, created_at: Date.now()
      });
    } else if (target === 'tiktok' && isVideo) {
      const filePath = await instagram.ensureLocalMedia(igMediaId);
      result = await tiktok.postVideo({
        filePath,
        caption: toTikTokCaption(media.caption, hashtags),
        privacyLevel: privacy || 'PUBLIC_TO_EVERYONE'
      });
      logAttempt({
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
      logAttempt({
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
    logAttempt({
      workflow_id: workflowId, ig_media_id: igMediaId, target,
      status: 'failed', remote_id: null, remote_url: null, error: errMsg, created_at: Date.now()
    });
    // Re-throw a plain Error with the safe message rather than the original — the original
    // may carry circular Axios internals (sockets/agents) that crash res.json() upstream.
    throw new Error(errMsg);
  }
}

/** Run a workflow: pick the next N un-posted IG videos and repost them to its target. */
async function runWorkflow(workflowId, { mediaIds = null } = {}) {
  const wf = getWorkflow(workflowId);
  if (!wf) throw new Error('Workflow not found');

  let candidates;
  if (mediaIds && mediaIds.length) {
    candidates = mediaIds;
  } else {
    const direction = wf.post_order === 'oldest_first' ? 'ASC' : 'DESC';
    const all = db.prepare(`SELECT id FROM ig_media ORDER BY timestamp ${direction}`).all().map(r => r.id);
    candidates = all.filter(id => !alreadyPosted(id, wf.target)).slice(0, wf.posts_per_run);
  }

  const outcomes = [];
  for (const igMediaId of candidates) {
    try {
      const r = await repostOne({ workflowId, igMediaId, target: wf.target, privacy: wf.privacy });
      outcomes.push({ igMediaId, ...r });
    } catch (err) {
      outcomes.push({ igMediaId, error: err.message });
    }
  }
  return outcomes;
}

module.exports = {
  createWorkflow, getWorkflow, listWorkflows, updateWorkflow, deleteWorkflow,
  runWorkflow, repostOne, getLog
};
