const db = require('./index');

function saveToken(provider, { access_token, refresh_token = null, expires_at = null, meta = {} }) {
  db.prepare(`
    INSERT INTO tokens (provider, access_token, refresh_token, expires_at, meta)
    VALUES (@provider, @access_token, @refresh_token, @expires_at, @meta)
    ON CONFLICT(provider) DO UPDATE SET
      access_token=excluded.access_token,
      refresh_token=COALESCE(excluded.refresh_token, tokens.refresh_token),
      expires_at=excluded.expires_at,
      meta=excluded.meta
  `).run({
    provider,
    access_token,
    refresh_token,
    expires_at,
    meta: JSON.stringify(meta || {})
  });
}

function getToken(provider) {
  const row = db.prepare(`SELECT * FROM tokens WHERE provider = ?`).get(provider);
  if (!row) return null;
  return { ...row, meta: JSON.parse(row.meta || '{}') };
}

function clearToken(provider) {
  db.prepare(`DELETE FROM tokens WHERE provider = ?`).run(provider);
}

module.exports = { saveToken, getToken, clearToken };
