const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const parser = require('cron-parser');
const db = require('../db');
const { ensureDbReady } = require('../db/ready');
const { runWorkflow } = require('../services/workflow');
const { safeErrorMessage } = require('../services/errors');

// --- Vercel Cron replacement for node-cron ---
//
// Vercel's Hobby plan only supports cron schedules that fire at most once per day (see
// vercel.json's `crons` entry, which fires this endpoint once daily). node-cron's in-process
// timers (server/services/scheduler.js) cannot run at all in serverless — there is no
// long-lived process to hold them — so this single daily tick replaces that entirely.
//
// SIMPLIFICATION (intentional, documented per the task brief): rather than building a general
// cron-schedule-matching engine that reconstructs "would this cron expression have fired at
// some point in the last ~24-27h", every enabled workflow with a non-null schedule_cron simply
// runs once whenever this endpoint fires, AS LONG AS its configured schedule implies a
// frequency of "at least once per day" (e.g. hourly, every-N-hours, daily-at-a-fixed-time).
// A workflow scheduled for less often than daily (e.g. "only on Mondays", or "the 1st of the
// month") is checked against a ~27-hour lookback window using cron-parser, so it does NOT fire
// every single day just because the cron tick itself runs daily.
//
// The accepted degradation: an hourly-scheduled workflow now runs at most once per day, at
// whatever fixed UTC time this cron tick fires (see vercel.json) — not hourly. This is a known,
// accepted limitation of the Hobby plan, not a bug. All timestamps here are UTC.
const LOOKBACK_MS = 27 * 60 * 60 * 1000; // ~27h: 24h + slop for slight timing drift

/**
 * True if `cronExpr`'s own implied interval is "at least daily" — i.e. two consecutive fires
 * computed from cron-parser are 24h or less apart. This lets a genuinely hourly/every-N-hours
 * workflow run every time this daily tick fires (the accepted degradation), while a workflow
 * meant to run weekly/monthly does NOT get bumped up to running daily.
 */
function impliesAtLeastDaily(cronExpr) {
  try {
    const interval = parser.parseExpression(cronExpr, { utc: true });
    const first = interval.next().getTime();
    const second = interval.next().getTime();
    return (second - first) <= 24 * 60 * 60 * 1000;
  } catch {
    return false; // unparsable expression — treat as not due, rather than guessing
  }
}

/**
 * True if `cronExpr` would have matched at least once in the last LOOKBACK_MS — used only for
 * schedules that are NOT "at least daily" (see impliesAtLeastDaily), so e.g. a weekly workflow
 * only runs on the day it's actually scheduled for, not every time the daily tick fires.
 */
function matchedWithinLookback(cronExpr, now) {
  try {
    const interval = parser.parseExpression(cronExpr, { utc: true, currentDate: new Date(now) });
    const prev = interval.prev().getTime();
    return (now - prev) <= LOOKBACK_MS;
  } catch {
    return false;
  }
}

function isDueToday(cronExpr, now) {
  if (impliesAtLeastDaily(cronExpr)) return true;
  return matchedWithinLookback(cronExpr, now);
}

/**
 * Verifies the request genuinely came from Vercel Cron, not a public caller who guessed the
 * URL. Vercel signs its own cron invocations with `Authorization: Bearer $CRON_SECRET` when a
 * `CRON_SECRET` env var is set (this is documented Vercel Cron behavior as of this writing —
 * double-check against current Vercel docs before deploying, since exact header conventions can
 * change between platform versions). CRON_SECRET is required here; if unset, every request is
 * rejected (fail closed) rather than allowing unauthenticated triggering of every workflow.
 */
function verifyCronRequest(req) {
  const secret = process.env.CRON_SECRET;
  if (!secret) return { ok: false, reason: 'CRON_SECRET is not configured on the server' };

  const header = req.headers['authorization'] || '';
  const expected = `Bearer ${secret}`;

  const a = Buffer.from(header);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    return { ok: false, reason: 'missing or invalid Authorization bearer token' };
  }
  return { ok: true };
}

router.get('/tick', async (req, res) => {
  const auth = verifyCronRequest(req);
  if (!auth.ok) {
    console.warn('[cron] rejected tick request:', auth.reason);
    return res.status(401).json({ error: 'Unauthorized', reason: auth.reason });
  }

  try {
    await ensureDbReady();

    const now = Date.now();
    const workflows = await db.prepare(
      `SELECT * FROM workflows WHERE enabled = 1 AND schedule_cron IS NOT NULL`
    ).all();

    const due = workflows.filter((wf) => isDueToday(wf.schedule_cron, now));
    const results = [];

    for (const wf of due) {
      // NOTE: runWorkflow()'s in-memory `runningWorkflows` Set (server/services/workflow.js)
      // only guards against overlap WITHIN this single invocation — it does NOT persist across
      // invocations/cold starts. Since this cron tick only fires once per day, the realistic
      // window for a genuine double-trigger (e.g. this tick plus a simultaneous manual "Run
      // now" click) is small; accepted as a known, low-risk gap rather than building
      // cross-invocation locking (e.g. a DB-backed advisory lock) for it.
      let outcome;
      try {
        const outcomes = await runWorkflow(wf.id);
        outcome = { workflowId: wf.id, name: wf.name, ok: true, outcomes };
      } catch (err) {
        outcome = { workflowId: wf.id, name: wf.name, ok: false, error: safeErrorMessage(err) };
      }
      results.push(outcome);

      // Recorded for observability only — last_run_at is NOT read back for due-calculation
      // (see isDueToday above), so a failed UPDATE here would not affect which workflows run.
      try {
        await db.prepare(`UPDATE workflows SET last_run_at = $1 WHERE id = $2`).run(Date.now(), wf.id);
      } catch (err) {
        console.error(`[cron] failed to update last_run_at for workflow ${wf.id}:`, err.message);
      }
    }

    console.log(`[cron] tick complete: ${due.length}/${workflows.length} workflow(s) due, ${results.filter(r => r.ok).length} succeeded`);
    res.json({
      ok: true,
      checkedAt: new Date(now).toISOString(),
      totalEnabledWithSchedule: workflows.length,
      dueCount: due.length,
      results
    });
  } catch (err) {
    console.error('[cron] tick failed:', err);
    res.status(500).json({ error: safeErrorMessage(err) });
  }
});

module.exports = router;
