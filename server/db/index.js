// SQLite layer backed by sql.js (pure WebAssembly — no native compilation required).
// Exposes a small synchronous-looking API (prepare().run/get/all(), exec()) so the
// rest of the app can use it exactly like better-sqlite3, after `init()` has resolved once at boot.

const path = require('path');
const fs = require('fs');
const initSqlJs = require('sql.js');

const DATA_DIR = path.join(__dirname, '..', '..', 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
const DB_FILE = path.join(DATA_DIR, 'app.db');

let SQL = null;
let sqljsDb = null;
let ready = false;
let saveTimer = null;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS tokens (
  provider TEXT PRIMARY KEY,
  access_token TEXT,
  refresh_token TEXT,
  expires_at INTEGER,
  meta TEXT
);

CREATE TABLE IF NOT EXISTS ig_media (
  id TEXT PRIMARY KEY,
  media_type TEXT,         -- IG's own type: VIDEO | REELS | IMAGE | CAROUSEL_ALBUM
  media_url TEXT,          -- for CAROUSEL_ALBUM, the first slide's URL
  first_slide_type TEXT,   -- VIDEO | IMAGE — what media_url actually points to (matters for carousels)
  permalink TEXT,
  caption TEXT,
  hashtags TEXT,
  timestamp TEXT,
  thumbnail_url TEXT,
  local_path TEXT,
  fetched_at INTEGER
);

CREATE TABLE IF NOT EXISTS workflows (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  target TEXT NOT NULL,
  enabled INTEGER DEFAULT 1,
  schedule_cron TEXT,
  posts_per_run INTEGER DEFAULT 1,
  caption_template TEXT,
  privacy TEXT DEFAULT 'public',
  post_order TEXT DEFAULT 'newest_first',
  created_at INTEGER
);

CREATE TABLE IF NOT EXISTS post_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  workflow_id INTEGER,
  ig_media_id TEXT,
  target TEXT,
  status TEXT,
  remote_id TEXT,
  remote_url TEXT,
  error TEXT,
  created_at INTEGER
);
`;

/**
 * Add columns that didn't exist in earlier versions of this app's schema, for databases
 * created before this column was introduced. CREATE TABLE IF NOT EXISTS above only handles
 * brand-new databases — existing ones need an explicit ALTER TABLE, and SQLite has no
 * "ADD COLUMN IF NOT EXISTS", so we check pragma table_info first.
 */
function columnNames(table) {
  const cols = sqljsDb.exec(`PRAGMA table_info(${table})`);
  return cols.length ? cols[0].values.map(row => row[1]) : [];
}

function runMigrations() {
  const workflowCols = columnNames('workflows');
  if (!workflowCols.includes('post_order')) {
    sqljsDb.run(`ALTER TABLE workflows ADD COLUMN post_order TEXT DEFAULT 'newest_first'`);
  }

  const igMediaCols = columnNames('ig_media');
  if (!igMediaCols.includes('first_slide_type')) {
    sqljsDb.run(`ALTER TABLE ig_media ADD COLUMN first_slide_type TEXT`);
  }
}

function scheduleSave() {
  // Debounce disk writes so bursts of inserts don't thrash the filesystem.
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try {
      const data = sqljsDb.export();
      fs.writeFileSync(DB_FILE, Buffer.from(data));
    } catch (err) {
      console.error('[db] failed to persist database:', err.message);
    }
  }, 50);
}

function saveNowSync() {
  if (!sqljsDb) return;
  const data = sqljsDb.export();
  fs.writeFileSync(DB_FILE, Buffer.from(data));
}

async function init() {
  if (ready) return;
  SQL = await initSqlJs({
    // Resolve the wasm file that ships inside the sql.js package.
    locateFile: (file) => path.join(require.resolve('sql.js/dist/sql-wasm.wasm'))
  });

  if (fs.existsSync(DB_FILE)) {
    const fileBuffer = fs.readFileSync(DB_FILE);
    sqljsDb = new SQL.Database(fileBuffer);
  } else {
    sqljsDb = new SQL.Database();
  }
  sqljsDb.run(SCHEMA);
  runMigrations();
  saveNowSync();
  ready = true;

  // Persist on graceful shutdown too.
  process.on('SIGINT', () => { saveNowSync(); process.exit(0); });
  process.on('SIGTERM', () => { saveNowSync(); process.exit(0); });
}

function assertReady() {
  if (!ready) {
    throw new Error('Database not initialized yet — call db.init() and await it before use (done automatically at server startup).');
  }
}

/** Convert sql.js's columns+values row shape into a plain object. */
function rowsToObjects(stmt) {
  const out = [];
  while (stmt.step()) {
    out.push(stmt.getAsObject());
  }
  stmt.free();
  return out;
}

/** sql.js's bind() throws on JS `undefined` (it only accepts null) — coerce any undefined to null. */
function toBindable(v) {
  return v === undefined ? null : v;
}

/** Bind either an array of positional params or an object of named params (@name). */
function bindParams(stmt, params) {
  if (params === undefined) return;
  if (Array.isArray(params)) {
    stmt.bind(params.map(toBindable));
  } else {
    // sql.js expects named placeholders prefixed with @, :, or $ — our SQL uses @name.
    const bound = {};
    for (const [k, v] of Object.entries(params)) bound['@' + k] = toBindable(v);
    stmt.bind(bound);
  }
}

// Normalize call-site arguments to a single params value, mimicking better-sqlite3:
// - no args                         -> undefined
// - one array/object arg            -> that array/object (positional list or named-param object)
// - one plain scalar arg            -> [scalar] (single positional param)
// - multiple scalar args            -> [...args] (positional params)
function normalizeArgs(args) {
  if (args.length === 0) return undefined;
  if (args.length === 1) {
    const a = args[0];
    if (Array.isArray(a) || (a && typeof a === 'object')) return a;
    return [a];
  }
  return args;
}

function prepare(sql) {
  assertReady();
  return {
    run(...args) {
      const params = normalizeArgs(args);
      const stmt = sqljsDb.prepare(sql);
      bindParams(stmt, params);
      stmt.step();
      stmt.free();
      scheduleSave();
      const lastId = sqljsDb.exec('SELECT last_insert_rowid() AS id')[0];
      const lastInsertRowid = lastId ? lastId.values[0][0] : undefined;
      return { lastInsertRowid, changes: sqljsDb.getRowsModified() };
    },
    get(...args) {
      const params = normalizeArgs(args);
      const stmt = sqljsDb.prepare(sql);
      bindParams(stmt, params);
      let result;
      if (stmt.step()) result = stmt.getAsObject();
      stmt.free();
      return result;
    },
    all(...args) {
      const params = normalizeArgs(args);
      const stmt = sqljsDb.prepare(sql);
      bindParams(stmt, params);
      return rowsToObjects(stmt);
    }
  };
}

function exec(sql) {
  assertReady();
  sqljsDb.run(sql);
  scheduleSave();
}

module.exports = { init, prepare, exec, isReady: () => ready };
