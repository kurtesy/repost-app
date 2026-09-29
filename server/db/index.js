// Postgres (Neon) layer backed by node-postgres (`pg`). Exposes an async API:
//   db.query(sql, params) -> { rows, rowCount, ... }   (pg's native result shape)
//   db.prepare(sql).run/get/all(...params)              (thin async wrapper, kept so call
//                                                         sites read close to the old sql.js
//                                                         shape — every method is now async
//                                                         and MUST be awaited)
//
// All placeholders in SQL strings are Postgres-style positional ($1, $2, ...). There is no
// support for named (@name) placeholders anymore — pg has no native equivalent, so every call
// site was converted to pass a plain, ordered array of values.

const { Pool, types } = require('pg');

// pg's default behavior is to return BIGINT columns (OID 20) as JS STRINGS, not numbers — this
// is deliberate on pg's part, since a 64-bit BIGINT can hold values that lose precision as a JS
// float. But every BIGINT column in this app's schema (created_at, fetched_at, expires_at,
// last_run_at — see SCHEMA below) stores an epoch-millisecond Date.now() value, which fits
// comfortably in a JS number, and every call site (this file's own callers, plus the frontend's
// `new Date(row.created_at)`) has always assumed a plain number, exactly like the old sql.js/
// better-sqlite3 layer returned. Without this override, `new Date("1727654321000")` — a numeric
// STRING — is `Invalid Date` in JavaScript (only date/time-formatted strings parse; a numeric
// string does not), which is exactly why the Activity Log's "When" column started showing
// "Invalid Date" after this app migrated from sql.js to Postgres. Registering this parser once,
// globally, for OID 20 fixes every BIGINT column's JSON serialization at once, rather than
// patching each individual API route/call site that happens to touch one.
types.setTypeParser(20, (val) => (val === null ? null : parseInt(val, 10)));

// In a serverless environment (Vercel), this module is cached across warm invocations within
// the same execution context/instance, so creating the Pool once at module load (rather than
// per-request) lets connections be reused instead of reopened on every function call. A brand
// new cold start gets a fresh module (and fresh Pool); Neon's pooled connection string (or its
// own PgBouncer-based pooling) is what keeps this cheap across many concurrent instances.
let pool = null;
let ready = false;

function getPool() {
  if (!pool) {
    if (!process.env.DATABASE_URL) {
      throw new Error('DATABASE_URL is not set — point it at your Neon Postgres connection string.');
    }
    pool = new Pool({
      connectionString: process.env.DATABASE_URL,
      // Neon requires SSL; rejectUnauthorized: false avoids needing Neon's CA bundle locally.
      ssl: { rejectUnauthorized: false }
    });
  }
  return pool;
}

// created_at / fetched_at / expires_at are stored as BIGINT epoch-milliseconds (Date.now()),
// matching exactly what the old SQLite INTEGER columns held. This is the least invasive choice
// since every call site already does `created_at: Date.now()` etc. and reads/compares them as
// plain JS numbers. The tradeoff: these columns are opaque to Postgres's date/time functions and
// tooling (no native TIMESTAMPTZ comparisons, no `NOW()` interop, indexes/EXPLAIN won't reason
// about them as time) — a future migration to TIMESTAMPTZ (storing ISO strings / `to_timestamp()`)
// would be preferable if this data is ever queried by time range directly in SQL, but is out of
// scope here since it would require touching every read site's assumption that these are numbers.
const SCHEMA = `
CREATE TABLE IF NOT EXISTS tokens (
  provider TEXT PRIMARY KEY,
  access_token TEXT,
  refresh_token TEXT,
  expires_at BIGINT,
  meta TEXT
);

CREATE TABLE IF NOT EXISTS ig_media (
  id TEXT PRIMARY KEY,
  media_type TEXT,          -- IG's own type: VIDEO | REELS | IMAGE | CAROUSEL_ALBUM
  media_product_type TEXT,  -- REELS | FEED | STORY | AD — confirmed: Graph API never returns
                            -- media_url for REELS regardless of post age (see SETUP.md)
  media_url TEXT,           -- for CAROUSEL_ALBUM, the first slide's URL
  first_slide_type TEXT,    -- VIDEO | IMAGE — what media_url actually points to (matters for carousels)
  permalink TEXT,
  caption TEXT,
  hashtags TEXT,
  timestamp TEXT,
  thumbnail_url TEXT,
  local_path TEXT,
  fetched_at BIGINT
);

CREATE TABLE IF NOT EXISTS workflows (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  target TEXT NOT NULL,
  enabled INTEGER DEFAULT 1,
  schedule_cron TEXT,
  posts_per_run INTEGER DEFAULT 1,
  caption_template TEXT,
  privacy TEXT DEFAULT 'public',
  post_order TEXT DEFAULT 'newest_first',
  upload_as TEXT DEFAULT 'shorts', -- 'shorts' | 'video' — YouTube workflows only; 'video' skips
                                   -- the #Shorts tag so YouTube classifies by actual video length
  created_at BIGINT
);

CREATE TABLE IF NOT EXISTS post_log (
  id SERIAL PRIMARY KEY,
  workflow_id INTEGER,
  ig_media_id TEXT,
  target TEXT,
  status TEXT,
  remote_id TEXT,
  remote_url TEXT,
  error TEXT,
  created_at BIGINT
);
`;

/**
 * Add columns that didn't exist in earlier versions of this app's schema, for databases
 * created before this column was introduced. Postgres supports `ADD COLUMN IF NOT EXISTS`
 * natively, so — unlike the old SQLite path — no need to inspect information_schema first;
 * kept as a helper anyway for the one column whose default depends on runtime state (none here
 * currently, but this mirrors the old structure and is easy to extend).
 */
async function columnNames(client, table) {
  const { rows } = await client.query(
    `SELECT column_name FROM information_schema.columns WHERE table_name = $1`,
    [table]
  );
  return rows.map(r => r.column_name);
}

async function runMigrations(client) {
  // Postgres's ADD COLUMN IF NOT EXISTS makes the old columnNames()-then-ALTER dance
  // unnecessary, but columnNames() is kept available/used here for parity and clarity.
  await client.query(`ALTER TABLE workflows ADD COLUMN IF NOT EXISTS post_order TEXT DEFAULT 'newest_first'`);
  await client.query(`ALTER TABLE workflows ADD COLUMN IF NOT EXISTS upload_as TEXT DEFAULT 'shorts'`);
  await client.query(`ALTER TABLE ig_media ADD COLUMN IF NOT EXISTS first_slide_type TEXT`);
  await client.query(`ALTER TABLE ig_media ADD COLUMN IF NOT EXISTS media_product_type TEXT`);
  // Observability only (not used for due-to-run logic — see server/routes/cron.js's simplified
  // "run once per day whenever this endpoint fires" scheduling model): records the last time
  // each workflow was attempted by the daily cron tick.
  await client.query(`ALTER TABLE workflows ADD COLUMN IF NOT EXISTS last_run_at BIGINT`);

  // Retained for parity with the old introspection-based approach / future use.
  void columnNames;
}

async function init() {
  if (ready) return;
  const p = getPool();

  // Verify connectivity before doing anything else.
  await p.query('SELECT 1');

  const client = await p.connect();
  try {
    await client.query(SCHEMA);
    await runMigrations(client);
  } finally {
    client.release();
  }

  ready = true;
}

function assertReady() {
  if (!ready) {
    throw new Error('Database not initialized yet — call db.init() and await it before use (done automatically at server startup).');
  }
}

/** Raw query passthrough — returns pg's native `{ rows, rowCount, ... }` result object. */
async function query(sql, params = []) {
  assertReady();
  return getPool().query(sql, params);
}

/**
 * Compatibility wrapper mimicking the old sql.js/better-sqlite3-flavored `prepare(sql)` shape,
 * but fully async — every method returns a Promise and MUST be awaited by callers.
 *
 * SQL passed here must already use Postgres positional placeholders ($1, $2, ...), not `?` or
 * `@name` — there's no rewriting/translation layer, since pg has no native support for named
 * parameters and every call site was updated to pass an ordered array instead.
 */
function prepare(sql) {
  assertReady();
  return {
    async run(...params) {
      const result = await getPool().query(sql, params);
      // Postgres has no built-in `last_insert_rowid()` equivalent; callers that need the
      // inserted id must add `RETURNING id` to their INSERT and read it off `rows[0].id`.
      const lastInsertRowid = result.rows && result.rows[0] ? result.rows[0].id : undefined;
      return { lastInsertRowid, changes: result.rowCount, rows: result.rows };
    },
    async get(...params) {
      const result = await getPool().query(sql, params);
      return result.rows[0];
    },
    async all(...params) {
      const result = await getPool().query(sql, params);
      return result.rows;
    }
  };
}

async function exec(sql) {
  assertReady();
  await getPool().query(sql);
}

module.exports = { init, query, prepare, exec, isReady: () => ready };
