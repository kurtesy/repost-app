const db = require('./server/db');
const path = require('path');
(async () => {
    await db.init();
    const mediaId = '<ig_media_id>';
    const filePath = path.join(__dirname, 'data', 'media', `${mediaId}.mp4`);
    await db.prepare(`UPDATE ig_media SET local_path = $1 WHERE id = $2`).run(filePath, mediaId);
    console.log('Updated local_path for', mediaId);
})();