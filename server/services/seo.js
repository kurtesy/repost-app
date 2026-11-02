// YouTube SEO: builds a search-optimised title, description, hashtags and tags from an Instagram
// caption. Pure functions, no network access, so the output can be previewed and tested offline.
//
// Rules implemented (see SEO.md for the reasoning and the parts that cannot be automated):
//   Title        [Primary keyword] | [Benefit] | [Format], keyword first, at most 70 characters.
//   Description  Line 1 starts with the same keyword plus a benefit and fits in 150 characters.
//                Lines 2-4 summarise the video and mention 2-3 related keywords. Then chapters (only
//                when real timestamps are supplied), source credit, links, and at most 3 hashtags.
//   Tags         3-5 close variants of the keyword, total kept under the 500 character API cap.
//   Shorts       Keyword in the title, #Shorts among the hashtags.
//
// Configuration (all optional, read from the environment):
//   YT_SEO_ENABLED       "0" turns this module off and restores the old caption-based fields.
//   SEO_TITLE_MAX        default 70
//   SEO_CREDIT_HANDLE    e.g. @thetwopisceans, used in the credit line
//   SEO_LINKS            links for the description, one per line or separated by "||" as "Label|url"
//   SEO_CATEGORY_ID      YouTube category id, default 19 (Travel & Events)
//   SEO_BENEFIT_DEFAULT  benefit label used when the caption gives no clue, default "Travel Guide"

const { removeSensitiveWords } = require('./caption');

const TITLE_MAX_DEFAULT = 70;
const DESCRIPTION_LIMIT = 4900;     // API cap is 5000 bytes; stay under it
const FIRST_LINE_LIMIT = 150;       // what search results and the feed show
const TAG_FIELD_LIMIT = 450;        // API cap is 500 characters; leave headroom for quoting
const TAG_MAX_LEN = 60;
const KEYWORD_MAX_CHARS = 45;
const KEYWORD_MAX_WORDS = 7;

const GENERIC_TAGS = new Set([
  'reels', 'reel', 'reelsinstagram', 'instagram', 'instagood', 'insta', 'viral', 'trending', 'fyp', 'foryou',
  'foryoupage', 'explore', 'explorepage', 'shorts', 'short', 'video', 'love', 'like', 'follow', 'followme',
  'photooftheday', 'photography', 'picoftheday', 'travel', 'traveling', 'travelling', 'travelgram',
  'wanderlust', 'vacation', 'holiday', 'reelitfeelit', 'trend', 'ootd', 'collab', 'ad', 'sponsored',
  'collaborations', 'collaboration', 'tourists', 'tourist', 'igtraveller', 'travelholic', 'traveller', 'travellers', 'traveler', 'travelers', 'traveladdict', 'travelpic', 'instatravel', 'traveltheworld', 'travelblogger'
]);

const STOPWORDS = new Set(['a', 'an', 'and', 'at', 'by', 'for', 'from', 'in', 'is', 'it', 'its', 'of', 'on', 'or', 'the', 'to', 'with', '&', 'but', 'that', 'this', 'your', 'you', 'i', 'my', 'we', 'our']);
const ACRONYMS = new Set(['nyc', 'usa', 'uk', 'uae', 'eu', 'us', 'lax', 'nyx', 'diy', 'tv', 'dc', 'la']);

const FILLER_OPENERS = /^(save this( for)?( your)?|pov|watch this|wait for it|you (need|have) to (see|visit|try)|this is your sign( to)?|ever wondered( what)?|did you know|can you believe|listen up|just go|don'?t miss this|hi+|hey+|good morning|swipe( for)?|discover|experience|enjoy|welcome to|meet)\b[\s,:;!.\-–—]*/i;

const CATEGORY_RULES = [
  { id: 'stay', re: /\b(hotels?|resorts?|villas?|suites?|hostels?|stays?|rooftop pool|spas?|airbnb|apartments?|rooms?)\b/i, benefit: 'Honest Stay Review', line: 'an honest look at the room, the view and the location', noun: 'hotel review' },
  { id: 'food', re: /\b(restaurants?|brunch|dinner|lunch|breakfast|caf[eé]s?|menu|food|tacos?|sushi|burgers?|pizza|street food|tapas|bistro)\b/i, benefit: 'Food Review', line: 'what we ordered, what it cost and what to skip', noun: 'restaurant review' },
  { id: 'guide', re: /\b(tours?|day trips?|itinerary|things to do|guide|trips?|hike|museum|castle|beach|waterfall|lake)\b/i, benefit: 'Travel Guide', line: 'how to plan it, what it costs and what to see', noun: 'travel guide' }
];

const CATEGORY_WORD = /\b(hotels?|resorts?|villas?|suites?|spa|restaurants?|caf[eé]s?|bistro|lodge|inn|hostels?)\b/i;
const ENTITY_RE = /((?:[A-Z][\p{L}'’&.-]+\s+){1,4}(?:Hotel|Resort|Villa|Suites?|Spa|Restaurant|Caf[eé]|Bistro|Lodge|Inn|Hostel)(?:\s+(?:&\s+)?[A-Z][\p{L}'’-]+){0,3})/u;

function categoryOf(text) {
  // Score every category by how often its words appear, so one stray "room" in a guide is not a hotel review.
  let best = null; let bestScore = 0;
  for (const rule of CATEGORY_RULES) {
    const hits = (text.match(new RegExp(rule.re.source, 'gi')) || []).length;
    const score = hits + (rule.id === 'guide' && /\b(itinerary|things to do|day trip|travel guide)\b/i.test(text) ? 2 : 0);
    if (score > bestScore) { best = rule; bestScore = score; }
  }
  if (best) return best;
  return { id: 'general', benefit: process.env.SEO_BENEFIT_DEFAULT || 'Travel Guide', line: 'what to know before you go', noun: 'travel guide' };
}

/** Strip links, mentions, hashtags, emoji and markup so only readable words remain. */
function cleanText(raw, { emojiBreak = false } = {}) {
  return removeSensitiveWords(raw || '')
    .replace(/https?:\/\/\S+/gi, ' ')
    .replace(/(^|\s)[@#][\w.]+/g, ' ')
    .replace(/[\u{1F000}-\u{1FFFF}\u{2600}-\u{27BF}\u{FE0F}\u{200D}\u{2B50}\u{2B06}\u{2194}-\u{21AA}]+/gu, emojiBreak ? ' • ' : ' ')
    .replace(/[<>]/g, '')
    .replace(/[ \t]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .trim();
}

function titleCase(s) {
  const small = new Set(['a', 'an', 'and', 'at', 'for', 'in', 'of', 'on', 'or', 'the', 'to', 'vs', 'with', 'under']);
  return s.split(/\s+/).map((w, i) => {
    const lower = w.toLowerCase();
    if (ACRONYMS.has(lower)) return lower.toUpperCase();
    if (i > 0 && small.has(lower)) return lower;
    return lower.charAt(0).toUpperCase() + lower.slice(1);
  }).join(' ');
}

function trimDangling(s) {
  const words = s.replace(/[\s,;:\-–—|&]+$/g, '').split(/\s+/);
  while (words.length > 1 && STOPWORDS.has(words[words.length - 1].toLowerCase())) words.pop();
  return words.join(' ').replace(/[\s,;:\-–—|]+$/g, '');
}

function truncateWords(s, max) {
  if (s.length <= max) return trimDangling(s);
  const cut = s.slice(0, max + 1);
  const space = cut.lastIndexOf(' ');
  return trimDangling(space > max * 0.5 ? cut.slice(0, space) : cut.slice(0, max));
}

const wordCount = (s) => s.split(/\s+/).filter(Boolean).length;

/** First readable clause of the caption, without filler openers, or '' when there is none. */
function firstClause(caption) {
  const lines = cleanText(caption, { emojiBreak: true }).split('\n').map((l) => l.trim()).filter(Boolean);
  for (const line of lines) {
    let s = line.replace(/\([^)]*\)|\[[^\]]*\]/g, ' ');
    let prev;
    do { prev = s; s = s.replace(/^[\s•]+/, '').replace(FILLER_OPENERS, ''); } while (s !== prev);
    s = s.split(/[.!?|•·…—]|\s[-–]\s|:\s/)[0].replace(/\s+/g, ' ').replace(/^[\W_]+|[\W_]+$/g, '').trim();
    s = trimDangling(s);
    if (wordCount(s) >= 2 && s.length >= 6) return s;
  }
  return '';
}

/** A first clause with no place name and no kind of venue (for example "This view and nothing else") is not searchable. */
function isWeakKeyword(kw) {
  return !kw || (!/[A-Z]/.test(kw.slice(1)) && !CATEGORY_WORD.test(kw));
}

/** The named venue in the caption ("Ramla Bay Resort"). */
function findVenueName(text) {
  const m = ENTITY_RE.exec(text);
  return m ? m[1].replace(/\s+/g, ' ').trim() : null;
}

/** "Vienna hotel" from a long sentence: its first place-like proper noun plus the kind of venue it mentions. */
function placeAndKind(clause) {
  const words = clause.split(/\s+/);
  const proper = words.slice(1).map((w) => w.replace(/['’]s$/i, '').replace(/[^\p{L}\p{N}'’-]/gu, '')).filter((w) => /^[A-Z\p{Lu}]/u.test(w) && !STOPWORDS.has(w.toLowerCase()));
  const first = words[0] && /^\p{Lu}/u.test(words[0]) && !STOPWORDS.has(words[0].toLowerCase()) && !FILLER_OPENERS.test(words[0]) ? words[0].replace(/['’]s$/i, '') : '';
  const place = proper[0] || first;
  const kind = (clause.match(CATEGORY_WORD) || [])[0];
  if (!place) return '';
  return titleCase(`${place} ${kind ? kind.toLowerCase().replace(/s$/, '') : 'travel guide'}`);
}

const NOT_PLACES = new Set(['day', 'days', 'part', 'best', 'top', 'hotel', 'resort', 'our', 'we', 'the', 'this', 'that', 'these', 'most', 'okay', 'some', 'every', 'why', 'how', 'what', 'where', 'when', 'who', 'weekend', 'summer', 'winter', 'spring', 'autumn', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday', 'january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december', 'instagram', 'reels', 'reel', 'hosted', 'collab', 'save', 'follow', 'link', 'bio', 'pov', 'dumps', 'photo', 'photos', 'video', 'tag', 'comment', 'share', 'book', 'booking', 'dm', 'if', 'and', 'but', 'for', 'from', 'not', 'just', 'one', 'two', 'three', 'here', 'there', 'then', 'now', 'sunrise', 'sunset', 'morning', 'night', 'tips', 'tip', 'guide', 'itinerary', 'please', 'thank', 'thanks', 'hi', 'hey', 'yes', 'no', 'maybe', 'also', 'after', 'before', 'with', 'without', 'all', 'any', 'more', 'less', 'only', 'real', 'first', 'last', 'next', 'new', 'old', 'big', 'small', 'free', 'full', 'half', 'late', 'early', 'real', 'honest', 'review', 'stay', 'stays', 'room', 'rooms', 'pool', 'view', 'views', 'beach', 'mountain', 'mountains', 'lake', 'city', 'town', 'island', 'sea', 'ocean']);
const squash = (x) => String(x).toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');

/** The most likely place name in the caption: a proper noun, favoured when a hashtag repeats it ("Dubai" and #dubaitravel). */
function findPlace(caption, hashtags = []) {
  const text = cleanText(caption).replace(/\[[^\]]*\]/g, ' ');
  const tagBlob = (hashtags || []).map(squash).join(' ');
  const counts = new Map();
  for (const sent of text.split(/(?<=[.!?])\s+|\n+/)) {
    const words = sent.split(/\s+/).map((w) => w.replace(/^[^\p{L}]+|[^\p{L}'’-]+$/gu, '').replace(/['’]s$/i, ''));
    let run = []; let runStart = 0;
    const flush = () => {
      if (run.length) {
        const key = run.join(' ');
        const cur = counts.get(key) || { n: 0, multi: run.length > 1, first: true };
        cur.n += 1; cur.multi = run.length > 1;
        if (runStart > 0 || run.length > 1) cur.first = false;
        counts.set(key, cur);
      }
      run = [];
    };
    words.forEach((w, i) => {
      const proper = /^\p{Lu}\p{Ll}[\p{L}'’-]*$/u.test(w) && !NOT_PLACES.has(w.toLowerCase()) && !STOPWORDS.has(w.toLowerCase());
      if (proper) { if (!run.length) runStart = i; run.push(w); } else flush();
    });
    flush();
  }
  let best = ''; let bestScore = 0;
  for (const [name, c] of counts) {
    const inTags = tagBlob.includes(squash(name));
    if (squash(name).length < 4 || /^(St|Mt|Dr|Mr|Mrs|Ms)\b/.test(name) && name.split(' ').length === 1) continue;
    if (c.first && !inTags) continue;          // a sentence-opening capital with no other evidence is just a capital
    const score = c.n * 2 + (inTags ? 3 : 0) + (c.multi ? 1 : 0);
    if (score > bestScore) { best = name; bestScore = score; }
  }
  return best;
}

/** A first clause that is a personal hook ("I don't know if...", "The Grand Canyon humbled me") rather than something people search for. */
const HOOK_RE = /\b(i|i['’]m|i['’]ve|i['’]d|we|we['’]re|we['’]ve|me|my|our|us|you|you['’]re|your|humbled|crushed|obsessed|dreamy|vibes?|dumps?|literally|insane|unreal|speechless|okay|wow|omg|not about|nothing else|duo)\b/i;
function isHook(clause) {
  return !!clause && HOOK_RE.test(clause);
}

/** "Dubai Itinerary", "Berlin Restaurant Review": a place plus the search intent the post answers. */
function placeIntent(place, text, cat) {
  if (/\b(itinerary|day \d|days in)\b/i.test(text)) return `${place} Itinerary`;
  if (cat.id === 'stay') return `${place} Hotel Review`;
  if (cat.id === 'food') return `${place} Restaurant Review`;
  return `${place} Travel Guide`;
}

/** The phrase people would search for. */
function extractPrimaryKeyword(caption, hashtags = []) {
  const clause = firstClause(caption);
  const full = cleanText(caption);
  const venue = findVenueName(full);

  let kw = '';
  const clauseOk = clause && wordCount(clause) <= KEYWORD_MAX_WORDS && clause.length <= KEYWORD_MAX_CHARS && !isWeakKeyword(clause);
  const place = findPlace(caption, hashtags);
  const fits = clause && wordCount(clause) <= KEYWORD_MAX_WORDS && clause.length <= KEYWORD_MAX_CHARS;
  if (!isHook(clause) && fits && (clauseOk || (place && clause.toLowerCase().includes(place.toLowerCase())))) kw = clause;
  else if (venue) kw = venue;
  else if (place) kw = placeIntent(place, `${full} ${(hashtags || []).join(' ')}`, categoryOf(`${full} ${(hashtags || []).join(' ')}`));
  else if (clauseOk) kw = clause;
  else if (clause && !isWeakKeyword(clause)) kw = placeAndKind(clause) || truncateWords(clause.split(/\s+/).slice(0, KEYWORD_MAX_WORDS).join(' '), KEYWORD_MAX_CHARS);
  else if (clause && wordCount(clause) <= KEYWORD_MAX_WORDS && clause.length <= KEYWORD_MAX_CHARS && clause.length >= 12) kw = clause;

  if (kw) {
    kw = trimDangling(kw.replace(/^(a|an|the)\s+/i, ''));
    kw = kw.charAt(0).toUpperCase() + kw.slice(1);
    const letters = kw.replace(/[^A-Za-z]/g, '');
    const upper = letters.replace(/[^A-Z]/g, '').length;
    if (letters.length > 4 && upper / letters.length > 0.6) kw = titleCase(kw);
    return truncateWords(kw, KEYWORD_MAX_CHARS);
  }
  const topics = usefulHashtagWords(hashtags);
  if (topics.length) return titleCase(`${topics[0]} travel guide`);
  return 'Travel Video';
}

function hashtagWords(tag) {
  return tag.replace(/^#/, '').replace(/([a-z])([A-Z])/g, '$1 $2').replace(/_/g, ' ').toLowerCase();
}

/** Hashtags that describe the video (places, topics), without the generic reach-bait ones. */
function usefulHashtagWords(hashtags) {
  const out = [];
  for (const tag of hashtags || []) {
    const raw = String(tag).replace(/^#/, '');
    const key = raw.toLowerCase();
    if (raw.length < 4 || GENERIC_TAGS.has(key) || /^\d+$/.test(raw)) continue;
    const words = hashtagWords(tag);
    if (!out.includes(words)) out.push(words);
  }
  return out;
}

function parseLinks(env = process.env.SEO_LINKS) {
  if (!env) return [];
  return env.split(/\n|\|\|/).map((l) => l.trim()).filter(Boolean).map((l) => {
    const [a, b] = l.split('|').map((x) => x.trim());
    return b ? `${a}: ${b}` : a;
  });
}

function sentences(text) {
  return text.replace(/\n+/g, ' ').split(/(?<=[.!?])\s+/).map((s) => s.trim()).filter((s) => s.length > 3);
}

function buildTitle({ keyword, benefit, format, max }) {
  const parts = [keyword, benefit, format].filter(Boolean);
  while (parts.length > 1 && parts.join(' | ').length > max) parts.pop();
  let title = parts.join(' | ');
  if (title.length > max) title = truncateWords(title, max);
  return title;
}

function formatChapters(chapters) {
  if (!Array.isArray(chapters) || chapters.length < 3) return '';        // YouTube needs 3+ chapters
  const toSec = (t) => String(t).split(':').reduce((a, n) => a * 60 + Number(n), 0);
  const sorted = chapters.slice().sort((a, b) => toSec(a.t) - toSec(b.t));
  if (toSec(sorted[0].t) !== 0) return '';                               // first chapter must be 0:00
  for (let i = 1; i < sorted.length; i++) if (toSec(sorted[i].t) - toSec(sorted[i - 1].t) < 10) return '';
  return 'Chapters\n' + sorted.map((c) => `${c.t} ${String(c.label).replace(/[<>]/g, '')}`).join('\n');
}

/** A question to pin as the first comment. Comments and replies are an engagement signal; ask something people answer. */
function pinnedCommentFor(cat, subject) {
  if (cat.id === 'stay') return `Would you stay here? Tell us where we should stay next, and ask anything about ${subject}.`;
  if (cat.id === 'food') return `Would you order this? Tell us what we should eat next, and ask anything about ${subject}.`;
  return `Planning ${subject}? Ask us anything and tell us where we should go next.`;
}

/**
 * Build the YouTube snippet fields for one video.
 * options: { asShorts = true, permalink, chapters, primaryKeyword, year, titleMax, handle }
 * Returns { title, description, tags, primaryKeyword, hashtags, categoryId, warnings[] }.
 */
function buildYouTubeSeo(caption, hashtags = [], options = {}) {
  const asShorts = options.asShorts !== false;
  const max = Number(options.titleMax || process.env.SEO_TITLE_MAX) || TITLE_MAX_DEFAULT;
  const year = options.year || new Date().getFullYear();
  const warnings = [];

  const keyword = (options.primaryKeyword || extractPrimaryKeyword(caption, hashtags)).replace(/[<>]/g, '').trim();
  const cat = categoryOf(`${cleanText(caption)} ${(hashtags || []).join(' ')}`);
  const format = asShorts ? 'Shorts' : 'Travel Vlog';
  const place = findPlace(caption, hashtags);
  // "Dubai Travel Guide | Travel Guide | Shorts" repeats itself; swap the benefit for a freshness signal.
  const benefit = new RegExp(cat.benefit.split(' ').slice(-1)[0], 'i').test(keyword) ? `${year} Tips` : cat.benefit;
  const title = buildTitle({ keyword, benefit, format, max });
  if (title.length < keyword.length) warnings.push('Keyword was shortened to fit the title limit.');
  if (isWeakKeyword(keyword) && !options.primaryKeyword) warnings.push(`Weak keyword "${keyword}": pass primaryKeyword for better search reach.`);

  // --- description ---
  // Bracketed or parenthesised keyword dumps ("[ Slow travel, Malta, Resort stays, ... ]") are not prose.
  const body = cleanText(caption)
    .replace(/\[[^\]]*\]/g, ' ')
    .replace(/\([^)]*,[^)]*,[^)]*\)/g, ' ')
    .replace(/[ \t]+/g, ' ');
  const related = usefulHashtagWords(hashtags).filter((w) => !keyword.toLowerCase().includes(w)).slice(0, 3);

  let first = `${keyword}: ${cat.line}.`;
  if (first.length > FIRST_LINE_LIMIT) first = truncateWords(`${keyword}: ${cat.line}`, FIRST_LINE_LIMIT - 1) + '.';

  const used = new Set();
  const summary = [];
  const kwNorm = keyword.toLowerCase().replace(/[^a-z0-9]/g, '');
  for (let s of sentences(body)) {
    // When a sentence opens with the keyword, keep only what follows it (line 1 already says the keyword).
    if (s.toLowerCase().startsWith(keyword.toLowerCase())) s = s.slice(keyword.length).replace(/^[\s\-–—:,;.!]+/, '');
    if (s.length <= 3) continue;
    const norm = s.toLowerCase().replace(/[^a-z0-9]/g, '');
    if (norm && (kwNorm.startsWith(norm.slice(0, 24)) || norm.startsWith(kwNorm.slice(0, 24)))) continue;   // the sentence the keyword came from is already line 1
    if (used.has(norm)) continue;
    used.add(norm);
    summary.push(s);
    if (summary.join(' ').length > 280 || summary.length === 3) break;
  }
  let summaryLine = summary.join(' ').replace(/[\s\-–—:,;]+$/, '');
  if (summaryLine.length > 320) summaryLine = truncateWords(summaryLine, 320) + '...';
  const relatedLine = related.length >= 2
    ? `Searching for ${related.slice(0, -1).join(', ')} or ${related[related.length - 1]}? This ${asShorts ? 'short' : 'video'} covers it.`
    : '';

  const hashtagOut = [];
  if (asShorts) hashtagOut.push('#Shorts');
  for (const w of usefulHashtagWords(hashtags)) {
    if (hashtagOut.length >= 3) break;
    hashtagOut.push('#' + w.replace(/\s+/g, ''));
  }
  if (hashtagOut.length < 3 && !asShorts) hashtagOut.push('#' + keyword.split(/\s+/).slice(0, 2).join('').replace(/[^\p{L}\p{N}]/gu, ''));
  const uniqueHashtags = [...new Set(hashtagOut.filter((h) => h.length > 2))].slice(0, 3);

  const handle = options.handle || process.env.SEO_CREDIT_HANDLE || '';
  const credit = [
    options.permalink ? `Originally posted on Instagram: ${options.permalink}` : '',
    handle ? `Follow ${handle} for more stays, food and places worth the trip.` : ''
  ].filter(Boolean).join('\n');
  const links = parseLinks();
  const chapters = asShorts ? '' : formatChapters(options.chapters);

  const blocks = [
    [first, summaryLine, relatedLine].filter(Boolean).join('\n'),
    chapters,
    credit,
    links.length ? links.join('\n') : '',
    uniqueHashtags.join(' ')
  ].filter(Boolean);
  const description = blocks.join('\n\n').slice(0, DESCRIPTION_LIMIT).replace(/[<>]/g, '');

  // --- tags: 3-5 variants of the keyword, kept under the field cap ---
  // Variants that read like real searches. "best ..." and "... review" only make sense for a short
  // noun phrase, not for a sentence about "our" trip.
  const k = keyword.toLowerCase();
  const personal = isHook(keyword) || /\b(this|these|that)\b/.test(k);
  const variants = [k];
  if (!personal && !/^best\b/.test(k) && !/\b(review|itinerary)$/.test(k)) variants.push(`best ${k}`);
  if (!personal && k.length <= 38 && !/\b(guide|review|itinerary)$/.test(k)) variants.push(cat.id === 'stay' || cat.id === 'food' ? `${k} review` : `${k} guide`);
  variants.push(`${k} ${year}`);
  if (place) {
    const pl = place.toLowerCase();
    variants.push(`things to do in ${pl}`, `${pl} ${cat.id === 'stay' ? 'hotel' : cat.id === 'food' ? 'restaurant' : 'travel'}`);
  }
  for (const r of related.slice(0, 2)) variants.push(/(hotel|resort|restaurant|guide|tour|trip|travel)/.test(r) ? r : `${r} ${cat.noun}`);
  const tags = [];
  let total = 0;
  for (const v of variants.map((x) => x.replace(/[<>,]/g, '').trim())) {
    if (!v || v.length > TAG_MAX_LEN || tags.includes(v)) continue;
    if (total + v.length + 1 > TAG_FIELD_LIMIT || tags.length >= 5) break;
    tags.push(v);
    total += v.length + 1;
  }
  if (tags.length < 3) warnings.push('Fewer than 3 tag variants could be produced.');
  if (!asShorts && !chapters) warnings.push('No chapters: pass 3+ timestamps starting at 0:00 to add them.');

  return {
    title, description, tags, primaryKeyword: keyword, hashtags: uniqueHashtags, place: place || null,
    pinnedComment: pinnedCommentFor(cat, place || keyword),
    categoryId: process.env.SEO_CATEGORY_ID || '19', warnings
  };
}

// ---------------------------------------------------------------------------------------------
// TikTok SEO. TikTok search reads the caption, the on-screen text, the spoken audio and the cover,
// not only hashtags. The app can write the caption and hashtags; the rest is returned as concrete
// instructions (onScreenText, spokenHook, coverText, altText) because they live inside the video.
//
//   Caption      Keyword in the first sentence, first 100 characters carry the keyword; max 2,200.
//   Hashtags     3-5: one broad, two niche, one branded. Generic reach tags (#fyp ...) are dropped.
//   On-screen    Keyword overlaid in the first 3 seconds.   Spoken: say it early.   Cover: readable text.
//   Alt text     Returned for image posts and carousels.
//   Watch time   Warns above 15 seconds when a duration is supplied.
//   Niche        Warns (or skips, with TIKTOK_NICHE_STRICT=1) when a post is outside the account niche.
//
// Environment (optional): SEO_BRAND_TAG (default from SEO_CREDIT_HANDLE, else #thetwopisceans),
// SEO_NICHE_WORDS (comma list), TIKTOK_NICHE_STRICT.
// ---------------------------------------------------------------------------------------------

const TIKTOK_CAPTION_LIMIT = 2200;
const TIKTOK_STRONG_CHARS = 100;
const TIKTOK_MAX_SECONDS = 15;
const ALT_TEXT_LIMIT = 100;
const TIKTOK_GENERIC = new Set([
  ...GENERIC_TAGS, 'tiktok', 'tiktokviral', 'tiktoktravel', 'xyzbca', 'xyzcba', 'parati', 'viralvideo', 'viraltiktok',
  'fypシ', 'community', 'collaborations', 'collaboration', 'tourists', 'tourist', 'igtraveller', 'travelholic', 'traveller', 'traveler', 'couple', 'couples', 'travelgoals', 'coupletravelgoals', 'instatravel', 'traveltheworld', 'travelblogger', 'fypage', 'foryourpage', 'goviral', 'blowthisup', 'fy', 'fypp', 'trendingvideo', 'new', 'fun', 'cute', 'beautiful', 'amazing'
]);
const BROAD_TAG = { stay: '#traveltok', food: '#foodtok', guide: '#traveltok', general: '#traveltok' };
const CATEGORY_TAG = { stay: '#hotelreview', food: '#restaurantreview', guide: '#travelguide', general: '#travelguide' };
const DEFAULT_NICHE_WORDS = 'travel,hotel,resort,stay,trip,tour,food,restaurant,cafe,brunch,dinner,lunch,breakfast,beach,city,flight,vacation,itinerary,spa,villa,airport,museum,hike,island,destination,europe,berlin';

function brandTag() {
  const explicit = process.env.SEO_BRAND_TAG;
  if (explicit) return explicit.startsWith('#') ? explicit : '#' + explicit;
  const handle = (process.env.SEO_CREDIT_HANDLE || '').replace(/^@/, '');
  return '#' + (handle || 'thetwopisceans').toLowerCase();
}

function nicheWords() {
  return (process.env.SEO_NICHE_WORDS || DEFAULT_NICHE_WORDS).split(',').map((w) => w.trim().toLowerCase()).filter(Boolean);
}

/** True when the post is about the account's niche (travel, stays, food). One niche per account keeps TikTok's classification clean. */
function isOnNiche(caption, hashtags = []) {
  const text = `${cleanText(caption)} ${(hashtags || []).join(' ')}`.toLowerCase();
  return nicheWords().some((w) => new RegExp(`\\b${w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, 'i').test(text));
}

function tagFromWords(words) {
  return '#' + words.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
}

function shortOverlay(keyword) {
  const words = keyword.split(/\s+/);
  let out = words.slice(0, 5).join(' ');
  if (out.length > 32) out = trimDangling(words.slice(0, 3).join(' '));
  return out;
}

/**
 * Build the TikTok caption, hashtags and the in-video checklist for one post.
 * options: { isVideo = true, durationSec, primaryKeyword, handle }
 * Returns { caption, hashtags, primaryKeyword, onScreenText, spokenHook, coverText, altText, onNiche, warnings[] }.
 */
function buildTikTokSeo(caption, hashtags = [], options = {}) {
  const isVideo = options.isVideo !== false;
  const warnings = [];
  const keyword = (options.primaryKeyword || extractPrimaryKeyword(caption, hashtags)).replace(/[<>]/g, '').trim();
  const cat = categoryOf(`${cleanText(caption)} ${(hashtags || []).join(' ')}`);
  if (isWeakKeyword(keyword) && !options.primaryKeyword) warnings.push(`Weak keyword "${keyword}": pass primaryKeyword for better search reach.`);

  // --- caption: keyword in sentence one, strong first 100 characters ---
  let first = `${keyword}: ${cat.line}.`;
  if (first.length > TIKTOK_STRONG_CHARS + 40) first = truncateWords(`${keyword}: ${cat.line}`, TIKTOK_STRONG_CHARS + 39) + '.';

  // Body: the original text with hashtags, links and bracketed keyword dumps removed. Emoji and @mentions stay.
  const body = removeSensitiveWords(caption || '')
    .replace(/https?:\/\/\S+/gi, ' ')
    .replace(/(^|\s)#[\w]+/g, ' ')
    .replace(/\[[^\]]*\]/g, ' ')
    .replace(/\([^)]*,[^)]*,[^)]*\)/g, ' ')
    .replace(/[<>]/g, '')
    .replace(/[ \t]+/g, ' ').replace(/ *\n */g, '\n').trim();
  const kwLower = keyword.toLowerCase();
  const rest = [];
  for (let s of sentences(body)) {
    if (s.toLowerCase().replace(/[^\p{L}\p{N} ]/gu, '').startsWith(kwLower)) s = s.slice(keyword.length).replace(/^[\s\-–—:,;.!]+/, '');
    if (s.length > 3) rest.push(s);
  }

  // --- hashtags: 1 broad, 2 niche, 1 branded (3-5 total), no generic reach tags ---
  const broad = BROAD_TAG[cat.id];
  const brand = brandTag();
  const niche = [];
  const place = findPlace(caption, hashtags);
  const keywordWords = keyword.split(/\s+/).length;
  if (place && squash(place).length >= 4) niche.push(tagFromWords(place), tagFromWords(place + ' travel'));
  if (keywordWords >= 2 && keywordWords <= 4 && keyword.length <= 30 && !isHook(keyword)) niche.push(tagFromWords(keyword));
  const okTag = (h) => { const k = String(h).replace(/^#/, '').toLowerCase(); return !TIKTOK_GENERIC.has(k) && !/(community|collab\w*|goals|holic|gram)$/.test(k); };
  for (const w of usefulHashtagWords((hashtags || []).filter(okTag))) niche.push(tagFromWords(w));
  niche.push(CATEGORY_TAG[cat.id]);
  const nicheTags = [...new Set(niche)].filter((t) => t.length >= 5 && t.length <= 30 && t !== broad && t !== brand);
  const tags = [broad, ...nicheTags.slice(0, 2), brand].filter(Boolean);
  if (tags.length < 5 && nicheTags[2] && !tags.includes(nicheTags[2])) tags.splice(tags.length - 1, 0, nicheTags[2]);
  const uniqueTags = [...new Set(tags)].slice(0, 5);
  if (uniqueTags.length < 3) warnings.push('Fewer than 3 hashtags could be produced.');

  // Saves and comments weigh in the ranking, so end with one clear ask.
  const cta = `Save this for your ${place || keyword} trip.`;
  const tagLine = uniqueTags.join(' ');
  const room = TIKTOK_CAPTION_LIMIT - tagLine.length - 2;
  const limit = Math.max(room - cta.length - 1, TIKTOK_STRONG_CHARS);
  let text = [first, ...rest].join('\n').slice(0, limit);
  if (text.length > 0 && rest.length && text.length === limit) text = text.replace(/\s+\S*$/, '') + '...';
  const out = `${text}\n${cta}\n\n${tagLine}`.slice(0, TIKTOK_CAPTION_LIMIT);

  // --- in-video signals the app cannot write for you ---
  const onScreenText = shortOverlay(keyword);
  const spokenHook = `Say "${keyword}" out loud in the first sentence.`;
  const coverText = onScreenText;
  const altText = isVideo ? null : truncateWords(`${keyword}. ${rest[0] || cat.line}`, ALT_TEXT_LIMIT);

  const dur = Number(options.durationSec);
  if (isVideo && dur > TIKTOK_MAX_SECONDS) warnings.push(`Video is ${Math.round(dur)}s. Reposts under ${TIKTOK_MAX_SECONDS}s with a fast hook keep completion rate high; consider trimming.`);
  const onNiche = isOnNiche(caption, hashtags);
  if (!onNiche) warnings.push('Outside the account niche (travel, stays, food). Mixed topics dilute how TikTok classifies the account.');

  return {
    caption: out, hashtags: uniqueTags, primaryKeyword: keyword, onScreenText, onScreenTextWindowSec: 3,
    spokenHook, coverText, altText, cta, place: place || null, onNiche, warnings
  };
}

function isEnabled() {
  return process.env.YT_SEO_ENABLED !== '0';
}

/** TikTok SEO is on unless TT_SEO_ENABLED=0. */
function isTikTokEnabled() {
  return process.env.TT_SEO_ENABLED !== '0';
}

/** Every title this app might have published for a caption, for duplicate detection and channel sync. */
function titleCandidates(caption, hashtags = []) {
  const { toYouTubeTitle } = require('./caption');
  const out = new Set([toYouTubeTitle(caption)]);
  for (const asShorts of [true, false]) out.add(buildYouTubeSeo(caption, hashtags, { asShorts }).title);
  return [...out].filter(Boolean);
}

module.exports = {
  buildYouTubeSeo, buildTikTokSeo, isOnNiche, titleCandidates, extractPrimaryKeyword, usefulHashtagWords, isEnabled, isTikTokEnabled,
  TITLE_MAX_DEFAULT, DESCRIPTION_LIMIT, TAG_FIELD_LIMIT, FIRST_LINE_LIMIT, TIKTOK_CAPTION_LIMIT, TIKTOK_STRONG_CHARS
};
