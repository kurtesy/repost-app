# Database migration: sql.js (SQLite/WASM) -> Postgres (Neon)

## Environment variable

- **`DATABASE_URL`** — Neon's standard Postgres connection string
  (e.g. `postgresql://user:password@ep-xxxx.region.aws.neon.tech/dbname?sslmode=require`).
  Required at runtime; `server/db/index.js` throws immediately if it's unset when the
  connection pool is first created.

The pool is created once per module load (`new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } })`)
and reused across requests/invocations within the same process — important in a serverless
context (Vercel), where the module can stay warm across multiple function invocations on the
same instance.

## Schema (current)

```sql
CREATE TABLE IF NOT EXISTS tokens (
  provider TEXT PRIMARY KEY,
  access_token TEXT,
  refresh_token TEXT,
  expires_at BIGINT,
  meta TEXT
);

CREATE TABLE IF NOT EXISTS ig_media (
  id TEXT PRIMARY KEY,
  media_type TEXT,
  media_product_type TEXT,
  media_url TEXT,
  first_slide_type TEXT,
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
  upload_as TEXT DEFAULT 'shorts',
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
```

Migrations (run every time `db.init()` is called, idempotent via `ADD COLUMN IF NOT EXISTS`):

```sql
ALTER TABLE workflows ADD COLUMN IF NOT EXISTS post_order TEXT DEFAULT 'newest_first';
ALTER TABLE workflows ADD COLUMN IF NOT EXISTS upload_as TEXT DEFAULT 'shorts';
ALTER TABLE ig_media ADD COLUMN IF NOT EXISTS first_slide_type TEXT;
ALTER TABLE ig_media ADD COLUMN IF NOT EXISTS media_product_type TEXT;
```

## SQLite -> Postgres changes, in brief

`INTEGER PRIMARY KEY AUTOINCREMENT` became `SERIAL PRIMARY KEY` (Postgres's auto-incrementing
integer). The `created_at` / `fetched_at` / `expires_at` columns — originally SQLite `INTEGER`
holding `Date.now()` epoch-millisecond values — became `BIGINT` rather than `TIMESTAMPTZ`: this
is the least invasive choice since every call site already treats them as plain JS numbers
(stores `Date.now()`, compares/sorts them numerically), but it means these columns are opaque to
Postgres's native date/time functions — a future change to `TIMESTAMPTZ` would be needed if the
data is ever queried by time range directly in SQL. Placeholders changed from SQLite's `?`
(positional) and `@name` (named) to Postgres's `$1, $2, ...` positional-only syntax, since `pg`
has no native named-parameter support; every call site was updated to pass a plain, ordered
array of values instead of a params object. The old `PRAGMA table_info` / manual `ALTER TABLE`
migration dance was replaced by Postgres's native `ADD COLUMN IF NOT EXISTS`, and `sql.js`'s
manual file-based persistence (debounced `fs.writeFileSync`, SIGINT/SIGTERM save handlers) was
removed entirely — Postgres persists writes immediately, so there's nothing to flush or save on
shutdown.

## API shape

`server/db/index.js` exposes:
- `db.query(sql, params)` — raw passthrough to `pg`, returns `{ rows, rowCount, ... }`.
- `db.prepare(sql)` — async compatibility wrapper: `{ run, get, all }`, all returning Promises
  (must be awaited). Kept because most call sites already used the `db.prepare(sql).run(...)`
  shape; only the SQL placeholders and the sync->async call sites needed to change, not the
  overall call pattern.
- `db.init()` — async; verifies connectivity (`SELECT 1`) and runs the schema + migrations.
  No longer loads/creates a file.

`run()`'s returned `{ lastInsertRowid, changes }` now requires the SQL itself to add a
`RETURNING id` clause (Postgres has no `last_insert_rowid()`); this was added to the two
INSERTs that relied on it (`workflow.js`'s `createWorkflow` and `logAttempt`). `changes` is
`pg`'s `rowCount`.
