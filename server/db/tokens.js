const db = require('./index');

async function saveToken(provider, { access_token, refresh_token = null, expires_at = null, meta = {} }) {
  await db.prepare(`
    INSERT INTO tokens (provider, access_token, refresh_token, expires_at, meta)
    VALUES ($1, $2, $3, $4, $5)
    ON CONFLICT(provider) DO UPDATE SET
      access_token=excluded.access_token,
      refresh_token=COALESCE(excluded.refresh_token, tokens.refresh_token),
      expires_at=excluded.expires_at,
      meta=excluded.meta
  `).run(
    provider,
    access_token,
    refresh_token,
    expires_at,
    JSON.stringify(meta || {})
  );
}

async function getToken(provider) {
  const row = await db.prepare(`SELECT * FROM tokens WHERE provider = $1`).get(provider);
  if (!row) return null;
  return { ...row, meta: JSON.parse(row.meta || '{}') };
}

async function clearToken(provider) {
  await db.prepare(`DELETE FROM tokens WHERE provider = $1`).run(provider);
}

module.exports = { saveToken, getToken, clearToken };
