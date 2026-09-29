const express = require('express');
const router = express.Router();
const instagram = require('../services/instagram');
const wf = require('../services/workflow');
const youtube = require('../services/youtube');
const { safeErrorMessage } = require('../services/errors');
const {
  toYouTubeTitle, toYouTubeDescription, toYouTubeTags, toTikTokCaption
} = require('../services/caption');

// --- Instagram media ---
router.get('/media', async (req, res) => {
  try {
    res.json(await instagram.listStoredMedia());
  } catch (err) {
    res.status(500).json({ error: safeErrorMessage(err) });
  }
});

router.post('/media/fetch', async (req, res) => {
  try {
    const limit = Number(req.body?.limit) || 50;
    const sinceDate = req.body?.sinceDate || null;
    const untilDate = req.body?.untilDate || null;
    const media = await instagram.fetchHistoricalMedia({ limit, sinceDate, untilDate });
    res.json(media);
  } catch (err) {
    res.status(500).json({ error: safeErrorMessage(err) });
  }
});

// Preview how a given IG post will map onto each platform, without posting.
router.get('/media/:id/preview', async (req, res) => {
  try {
    const all = await instagram.listStoredMedia();
    const media = all.find(m => m.id === req.params.id);
    if (!media) return res.status(404).json({ error: 'not found' });
    res.json({
      youtube: {
        title: toYouTubeTitle(media.caption),
        description: toYouTubeDescription(media.caption, media.hashtags),
        tags: toYouTubeTags(media.hashtags)
      },
      tiktok: {
        caption: toTikTokCaption(media.caption, media.hashtags)
      }
    });
  } catch (err) {
    res.status(500).json({ error: safeErrorMessage(err) });
  }
});

// --- Workflows ---
router.get('/workflows', async (req, res) => {
  try {
    res.json(await wf.listWorkflows());
  } catch (err) {
    res.status(500).json({ error: safeErrorMessage(err) });
  }
});

router.post('/workflows', async (req, res) => {
  try {
    const { name, target, scheduleCron, postsPerRun, privacy, postOrder, uploadAs } = req.body;
    if (!name || !['youtube', 'tiktok'].includes(target)) {
      return res.status(400).json({ error: 'name and target (youtube|tiktok) are required' });
    }
    const created = await wf.createWorkflow({ name, target, scheduleCron: scheduleCron || null, postsPerRun: postsPerRun || 1, privacy, postOrder, uploadAs });
    // No scheduler.reloadAll() anymore — node-cron's in-process scheduler was removed for the
    // serverless build. The workflow's schedule_cron is read fresh from the DB by GET
    // /api/cron/tick on every daily Vercel Cron fire, so there's nothing to "reload" here.
    res.json(created);
  } catch (err) {
    res.status(500).json({ error: safeErrorMessage(err) });
  }
});

router.put('/workflows/:id', async (req, res) => {
  try {
    const updated = await wf.updateWorkflow(Number(req.params.id), req.body);
    res.json(updated);
  } catch (err) {
    res.status(500).json({ error: safeErrorMessage(err) });
  }
});

router.delete('/workflows/:id', async (req, res) => {
  try {
    await wf.deleteWorkflow(Number(req.params.id));
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: safeErrorMessage(err) });
  }
});

// Manually run a workflow now; optionally pass specific mediaIds to post.
router.post('/workflows/:id/run', async (req, res) => {
  try {
    const outcomes = await wf.runWorkflow(Number(req.params.id), { mediaIds: req.body?.mediaIds || null });
    res.json(outcomes);
  } catch (err) {
    res.status(500).json({ error: safeErrorMessage(err) });
  }
});

// --- YouTube channel sync ---
// Reconciles post_log against what's actually on the connected YouTube channel — catches videos
// uploaded manually, or posted by this app before a post_log write succeeded. See
// server/services/youtube.js's syncChannelUploads for the matching logic and why 'synced' is a
// distinct status from 'success'.
router.post('/sync/youtube', async (req, res) => {
  try {
    const result = await youtube.syncChannelUploads();
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: safeErrorMessage(err) });
  }
});

// --- Log ---
router.get('/log', async (req, res) => {
  try {
    res.json(await wf.getLog({ limit: Number(req.query.limit) || 100 }));
  } catch (err) {
    res.status(500).json({ error: safeErrorMessage(err) });
  }
});

module.exports = router;
