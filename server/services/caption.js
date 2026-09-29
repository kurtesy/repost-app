/** Extract hashtags from an IG caption and return { text, hashtags[] }. */
function parseCaption(rawCaption) {
  const caption = rawCaption || '';
  const hashtags = Array.from(caption.matchAll(/#[\w]+/g)).map(m => m[0]);
  return { text: caption, hashtags };
}

/** Build a YouTube title from caption (YT titles are capped at 100 chars). */
function toYouTubeTitle(caption) {
  const firstLine = (caption || '').split('\n')[0].trim();
  const clean = firstLine.replace(/#[\w]+/g, '').trim();
  const title = clean || 'Reel repost';
  return title.length > 95 ? title.slice(0, 92) + '...' : title;
}

/**
 * Build a YouTube description: full caption + hashtags, optionally + #Shorts.
 * asShorts (default true): when false, skips the #Shorts tag entirely so YouTube classifies
 * the upload based on its actual video properties (length/aspect ratio) instead of being
 * forced into Shorts — for workflows posting as regular videos.
 */
function toYouTubeDescription(caption, hashtags, asShorts = true) {
  const base = (caption || '').trim();
  const tagLine = hashtags.length ? `\n\n${hashtags.join(' ')}` : '';
  const shortsTag = asShorts && !/#shorts/i.test(base) ? '\n#Shorts' : '';
  return `${base}${tagLine}${shortsTag}`.trim().slice(0, 4900);
}

/** YouTube tags: plain keywords (no # symbol), max ~500 chars total per API guidance. */
function toYouTubeTags(hashtags) {
  const tags = hashtags.map(h => h.replace(/^#/, ''));
  const out = [];
  let total = 0;
  for (const t of tags) {
    if (total + t.length + 1 > 450) break;
    out.push(t);
    total += t.length + 1;
  }
  return out;
}

/** TikTok caption: full caption text + hashtags inline (TikTok has no separate tags field). */
function toTikTokCaption(caption, hashtags) {
  const base = (caption || '').trim();
  const hasInlineTags = hashtags.every(h => base.includes(h));
  const full = hasInlineTags ? base : `${base}\n\n${hashtags.join(' ')}`.trim();
  return full.slice(0, 2200);
}

module.exports = {
  parseCaption,
  toYouTubeTitle,
  toYouTubeDescription,
  toYouTubeTags,
  toTikTokCaption
};
