/**
 * One-off script: download every stored Reel via yt-dlp and set its local_path, so future
 * workflow runs (and TikTok/YouTube posting) use the cached local file immediately instead of
 * re-downloading on demand. Safe to re-run — posts that already have a valid local_path are
 * skipped (same caching behavior as ensureLocalMedia() during a normal workflow run).
 *
 * Requires yt-dlp set up per SETUP.md ("Reels and yt-dlp") — either in repost-app/.venv or on
 * your global PATH.
 *
 * Usage (from the repost-app project root):
 *   node scripts/backfill-reel-downloads.js
 */

const db = require('../server/db');
const instagram = require('../server/services/instagram');

async function main() {
  await db.init();

  const reels = await db.prepare(`SELECT * FROM ig_media WHERE media_product_type = 'REELS' ORDER BY timestamp DESC`).all();

  if (!reels.length) {
    console.log('No Reels found in the database. Nothing to do.');
    return;
  }

  console.log(`Found ${reels.length} Reel(s). Downloading via yt-dlp...\n`);

  let succeeded = 0;
  let alreadyCached = 0;
  let failed = 0;

  for (const reel of reels) {
    const wasAlreadyLocal = !!reel.local_path;
    try {
      const filePath = await instagram.ensureLocalMedia(reel.id);
      if (wasAlreadyLocal) {
        alreadyCached++;
        console.log(`[cached]  ${reel.id} — already had a local file (${filePath})`);
      } else {
        succeeded++;
        console.log(`[ok]      ${reel.id} — downloaded to ${filePath}`);
      }
    } catch (err) {
      failed++;
      console.error(`[FAILED]  ${reel.id} — ${err.message}`);
    }
  }

  console.log(`\nDone. ${succeeded} downloaded, ${alreadyCached} already cached, ${failed} failed.`);
  if (failed > 0) {
    console.log('Failed posts are unchanged in the database — re-run this script after fixing the underlying issue (e.g. installing yt-dlp) to retry just those.');
  }
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('Fatal error:', err.message);
    process.exit(1);
  });
