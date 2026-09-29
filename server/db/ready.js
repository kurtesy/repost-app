// Lazy, memoized DB initialization for serverless.
//
// server/db/index.js's init() runs `CREATE TABLE IF NOT EXISTS` + migrations — cheap once done,
// but Vercel has no one-time "boot" phase like a long-running Express process does. Every cold
// start re-imports this module fresh, so a plain module-level Promise gives correct behavior in
// both worlds:
//   - Cold start: `initPromise` is undefined -> init() runs once for this container.
//   - Warm invocation (same container reused): `initPromise` is already resolved -> ensureDbReady()
//     resolves immediately without re-running init() or re-querying information_schema.
// This mirrors exactly what the DB pool itself already does (module-level `pool` in db/index.js).
const db = require('./index');

let initPromise = null;

async function ensureDbReady() {
  if (!initPromise) {
    initPromise = db.init().catch((err) => {
      // Reset so the NEXT invocation retries init() instead of permanently caching a failure
      // (e.g. a transient Neon connectivity blip shouldn't wedge every future request in this
      // process until it's recycled).
      initPromise = null;
      throw err;
    });
  }
  return initPromise;
}

module.exports = { ensureDbReady };
