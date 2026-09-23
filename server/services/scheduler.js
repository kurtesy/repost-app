const cron = require('node-cron');
const { listWorkflows, runWorkflow } = require('./workflow');

const activeTasks = new Map(); // workflowId -> cron task

function stopAll() {
  for (const task of activeTasks.values()) task.stop();
  activeTasks.clear();
}

function scheduleWorkflow(wf) {
  if (activeTasks.has(wf.id)) {
    activeTasks.get(wf.id).stop();
    activeTasks.delete(wf.id);
  }
  if (!wf.enabled || !wf.schedule_cron) return;
  if (!cron.validate(wf.schedule_cron)) {
    console.warn(`[scheduler] invalid cron for workflow ${wf.id}: ${wf.schedule_cron}`);
    return;
  }
  const task = cron.schedule(wf.schedule_cron, async () => {
    console.log(`[scheduler] running workflow #${wf.id} (${wf.name})`);
    try {
      const outcomes = await runWorkflow(wf.id);
      console.log(`[scheduler] workflow #${wf.id} outcomes:`, outcomes);
    } catch (err) {
      console.error(`[scheduler] workflow #${wf.id} failed:`, err.message);
    }
  });
  activeTasks.set(wf.id, task);
}

function reloadAll() {
  stopAll();
  for (const wf of listWorkflows()) scheduleWorkflow(wf);
}

module.exports = { reloadAll, scheduleWorkflow, stopAll };
