/**
 * Safely extract a human-readable, JSON-serializable message from any thrown error —
 * including raw Axios errors whose `response.data` is a live stream/socket object
 * (e.g. when `responseType: 'stream'` is used and the server returns a non-2xx status).
 * Naively JSON.stringify-ing such an error throws "Converting circular structure to JSON"
 * because streams carry references back to their underlying TLSSocket/Agent.
 */
function safeErrorMessage(err) {
  if (!err) return 'Unknown error';

  const data = err.response?.data;
  if (data !== undefined && data !== null) {
    // Plain JSON error bodies (the common case: parsed API error responses) are safe to stringify.
    if (typeof data === 'string') return data;
    if (Buffer.isBuffer(data)) return data.toString('utf8').slice(0, 2000);
    if (typeof data === 'object' && typeof data.pipe !== 'function' && typeof data.on !== 'function') {
      try {
        return JSON.stringify(data);
      } catch {
        // Fall through to status-based message below on any unexpected circular shape.
      }
    }
    // A stream (or anything else non-serializable) — fall back to status info instead of the body.
    const status = err.response?.status;
    return `Request failed${status ? ` with status ${status}` : ''} (response body was a stream and could not be read for this error message)`;
  }

  if (err.code === 'ECONNRESET' || err.code === 'ETIMEDOUT' || err.code === 'ENOTFOUND') {
    return `Network error (${err.code}): ${err.message || 'connection failed'}`;
  }

  return err.message || String(err);
}

module.exports = { safeErrorMessage };
