const express = require('express');
const router = express.Router();
const instagram = require('../services/instagram');
const wf = require('../services/workflow');
const scheduler = require('../services/scheduler');
const { safeErrorMessage } = require('../services/errors');
const {
  toYouTubeTitle, toYouTubeDescription, toYouTubeTags, toTikTokCaption
} = require('../services/caption');

// --- Instagram media ---
router.get('/media', (req, res) => {
  res.json(instagram.listStoredMedia());
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
router.get('/media/:id/preview', (req, res) => {
  const all = instagram.listStoredMedia();
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
});

// --- Workflows ---
router.get('/workflows', (req, res) => res.json(wf.listWorkflows()));

router.post('/workflows', (req, res) => {
  const { name, target, scheduleCron, postsPerRun, privacy, postOrder } = req.body;
  if (!name || !['youtube', 'tiktok'].includes(target)) {
    return res.status(400).json({ error: 'name and target (youtube|tiktok) are required' });
  }
  const created = wf.createWorkflow({ name, target, scheduleCron: scheduleCron || null, postsPerRun: postsPerRun || 1, privacy, postOrder });
  scheduler.reloadAll();
  res.json(created);
});

router.put('/workflows/:id', (req, res) => {
  const updated = wf.updateWorkflow(Number(req.params.id), req.body);
  scheduler.reloadAll();
  res.json(updated);
});

router.delete('/workflows/:id', (req, res) => {
  wf.deleteWorkflow(Number(req.params.id));
  scheduler.reloadAll();
  res.json({ ok: true });
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

// --- Log ---
router.get('/log', (req, res) => res.json(wf.getLog({ limit: Number(req.query.limit) || 100 })));

module.exports = router;
