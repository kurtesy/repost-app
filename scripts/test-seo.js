// Checks the YouTube SEO rules against synthetic captions and, when present, every caption in
// instagram-metadata.json. Run: node scripts/test-seo.js   (add --show to print sample output)
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const seo = require('../server/services/seo');

let n = 0;
const ok = (name, fn) => { fn(); n++; };

// --- the rules from the brief, on a clean caption ---
const taco = 'Best street tacos in Berlin under €10 🌮🔥 We tried five stands at Markthalle Neun and ranked them. The al pastor wins. Save this for your next Berlin trip! #berlin #streetfood #foodie #reels';
ok('title leads with the keyword and stays under 70', () => {
  const r = seo.buildYouTubeSeo(taco, ['#berlin', '#streetfood', '#foodie', '#reels'], { asShorts: false });
  assert(r.title.toLowerCase().startsWith('best street tacos in berlin under'), r.title);
  assert(r.title.length <= 70, r.title);
  assert(r.title.includes(' | '), r.title);
});
ok('description line 1 repeats the keyword and fits 150 chars', () => {
  const r = seo.buildYouTubeSeo(taco, ['#berlin', '#streetfood'], { asShorts: true });
  const first = r.description.split('\n')[0];
  assert(first.toLowerCase().startsWith(r.primaryKeyword.toLowerCase()), first);
  assert(first.length <= 150, first.length);
});
ok('at most 3 hashtags, at the end, #Shorts only for Shorts', () => {
  const tags = ['#berlin', '#streetfood', '#foodie', '#markthalle', '#tacos'];
  const s = seo.buildYouTubeSeo(taco, tags, { asShorts: true });
  const v = seo.buildYouTubeSeo(taco, tags, { asShorts: false });
  const lastS = s.description.trim().split('\n').pop();
  assert((lastS.match(/#\w+/g) || []).length <= 3 && lastS.includes('#Shorts'), lastS);
  assert(!v.description.includes('#Shorts'));
  assert(v.description.trim().split('\n').pop().startsWith('#'));
});
ok('tags: 3-5 variants, under the character cap', () => {
  const r = seo.buildYouTubeSeo(taco, ['#berlin'], {});
  assert(r.tags.length >= 3 && r.tags.length <= 5, r.tags.join(','));
  assert(r.tags.join(',').length <= 450);
});
ok('chapters only when valid (3+, start at 0:00, 10s apart), never on Shorts', () => {
  const good = [{ t: '0:00', label: 'Intro' }, { t: '0:45', label: 'Stand one' }, { t: '2:10', label: 'Verdict' }];
  assert(seo.buildYouTubeSeo(taco, [], { asShorts: false, chapters: good }).description.includes('0:45 Stand one'));
  assert(!seo.buildYouTubeSeo(taco, [], { asShorts: true, chapters: good }).description.includes('Chapters'));
  assert(!seo.buildYouTubeSeo(taco, [], { asShorts: false, chapters: good.slice(0, 2) }).description.includes('Chapters'));
  assert(!seo.buildYouTubeSeo(taco, [], { asShorts: false, chapters: [{ t: '0:05', label: 'a' }, { t: '1:00', label: 'b' }, { t: '2:00', label: 'c' }] }).description.includes('Chapters'));
});
ok('source credit and links are included', () => {
  process.env.SEO_LINKS = 'Website|https://www.thetwopisceans.com';
  process.env.SEO_CREDIT_HANDLE = '@thetwopisceans';
  const r = seo.buildYouTubeSeo(taco, [], { permalink: 'https://www.instagram.com/reel/abc/' });
  assert(r.description.includes('Originally posted on Instagram: https://www.instagram.com/reel/abc/'));
  assert(r.description.includes('Website: https://www.thetwopisceans.com'));
  assert(r.description.includes('@thetwopisceans'));
  delete process.env.SEO_LINKS; delete process.env.SEO_CREDIT_HANDLE;
});
ok('filler openers and ALL CAPS are cleaned', () => {
  assert.strictEqual(seo.extractPrimaryKeyword('Save this for your Tenerife trip. Why we loved it'), 'Tenerife trip');
  assert.strictEqual(seo.extractPrimaryKeyword('HOTEL REVERON PLAZA, LOS CRISTIANOS - my best pick'), 'Hotel Reveron Plaza, Los Cristianos');
});
ok('angle brackets never reach YouTube, empty captions still work', () => {
  const r = seo.buildYouTubeSeo('<script>x</script> Great view', [], {});
  assert(!/[<>]/.test(r.title + r.description + r.tags.join('')));
  const e = seo.buildYouTubeSeo('', [], {});
  assert(e.title.length > 0 && e.tags.length >= 1);
});
ok('explicit keyword override wins', () => {
  assert(seo.buildYouTubeSeo(taco, [], { primaryKeyword: 'Berlin Food Tour' }).title.startsWith('Berlin Food Tour'));
});
ok('title candidates cover legacy and SEO titles', () => {
  assert(seo.titleCandidates(taco, ['#berlin']).length >= 2);
});

// --- search-intent keywords ---
ok('personal hooks become place + intent keywords', () => {
  assert.strictEqual(seo.extractPrimaryKeyword('The Grand Canyon humbled me. We hiked Grand Canyon West at sunrise and Grand Canyon was unreal.', ['#grandcanyon']).startsWith('Grand Canyon'), true);
  const k = seo.extractPrimaryKeyword('Dubai Day 1 itinerary. I loved it, we saw Burj Khalifa and Dubai Marina', ['#dubaitravel']);
  assert(/Dubai/.test(k), k);
});
ok('title does not repeat the benefit and tags have no doubled words', () => {
  const r = seo.buildYouTubeSeo('We loved Berlin so much. Berlin has the best food. Berlin tips for first timers.', ['#berlin'], {});
  assert(!/Travel Guide \| Travel Guide/.test(r.title), r.title);
  assert(!r.tags.some((t) => /\b(\w+) \1\b/.test(t)), r.tags.join(','));
  assert(r.pinnedComment && r.pinnedComment.length > 10);
});
ok('tiktok: generic community-style hashtags are dropped, save ask is added', () => {
  const r = seo.buildTikTokSeo('Chefchaouen blue city. Morocco is magic.', ['#chefchaouen', '#igtraveller', '#travelcommunity', '#coupletravelgoals'], {});
  assert(!r.hashtags.some((t) => /igtraveller|community|goals/.test(t)), r.hashtags.join(' '));
  assert(/Save this for your/.test(r.caption));
});

// --- TikTok ---
ok('tiktok: keyword in first sentence and first 100 chars, caption <= 2200', () => {
  const r = seo.buildTikTokSeo(taco, ['#berlin', '#streetfood', '#fyp'], {});
  assert(r.caption.slice(0, 100).toLowerCase().includes(r.primaryKeyword.toLowerCase().slice(0, 20)), r.caption.slice(0, 100));
  assert(r.caption.length <= 2200);
});
ok('tiktok: 3-5 hashtags, one broad, one branded, no generics', () => {
  process.env.SEO_CREDIT_HANDLE = '@thetwopisceans';
  const r = seo.buildTikTokSeo(taco, ['#berlin', '#fyp', '#foryou', '#viral', '#streetfood'], {});
  assert(r.hashtags.length >= 3 && r.hashtags.length <= 5, r.hashtags.join(' '));
  assert(r.hashtags.includes('#foodtok') || r.hashtags.includes('#traveltok'));
  assert(r.hashtags.includes('#thetwopisceans'), r.hashtags.join(' '));
  assert(!r.hashtags.some((t) => /^#(fyp|foryou|viral|foryoupage)$/.test(t)), r.hashtags.join(' '));
  assert(r.caption.trim().split('\n').pop().split(' ').length === r.hashtags.length);
  delete process.env.SEO_CREDIT_HANDLE;
});
ok('tiktok: on-screen text, cover, spoken hook; alt text only for images', () => {
  const v = seo.buildTikTokSeo(taco, [], {});
  assert(v.onScreenText && v.onScreenText.length <= 32 && v.coverText === v.onScreenText && /out loud/.test(v.spokenHook));
  assert.strictEqual(v.altText, null);
  const i = seo.buildTikTokSeo(taco, [], { isVideo: false });
  assert(i.altText && i.altText.length <= 100, i.altText);
});
ok('tiktok: warns above 15 seconds and when off-niche', () => {
  assert(seo.buildTikTokSeo(taco, [], { durationSec: 22 }).warnings.some((w) => /22s/.test(w)));
  assert(!seo.buildTikTokSeo(taco, [], { durationSec: 12 }).warnings.some((w) => /\ds\./.test(w)));
  const off = seo.buildTikTokSeo('Cryptocurrency market update: bitcoin price analysis today', ['#crypto'], {});
  assert.strictEqual(off.onNiche, false);
  assert(off.warnings.some((w) => /niche/i.test(w)));
  assert.strictEqual(seo.isOnNiche(taco, []), true);
});
ok('tiktok: long captions are cut to 2200 with hashtags kept', () => {
  const r = seo.buildTikTokSeo('Hotel review in Vienna. ' + 'Great rooftop pool and breakfast. '.repeat(200), ['#vienna'], {});
  assert(r.caption.length <= 2200 && /#\w+$/.test(r.caption.trim()));
});

// --- every real caption must satisfy the hard limits ---
const file = path.join(__dirname, '..', 'instagram-metadata.json');
if (fs.existsSync(file)) {
  const posts = JSON.parse(fs.readFileSync(file, 'utf8')).posts;
  let bad = 0;
  for (const p of posts) {
    for (const asShorts of [true, false]) {
      const r = seo.buildYouTubeSeo(p.caption, p.tags, { asShorts, permalink: p.permalink });
      const first = r.description.split('\n')[0];
      const problems = [];
      if (r.title.length > 70) problems.push('title>70');
      if (!r.title.toLowerCase().startsWith(r.primaryKeyword.toLowerCase().slice(0, Math.min(20, r.title.length)))) problems.push('keyword not first');
      if (first.length > 150) problems.push('line1>150');
      if ((r.description.trim().split('\n').pop().match(/#\w+/g) || []).length > 3) problems.push('hashtags>3');
      if (r.description.length > 4900) problems.push('description too long');
      if (r.tags.join(',').length > 500 || r.tags.length > 5) problems.push('tags');
      if (/[<>]/.test(r.title + r.description + r.tags.join(''))) problems.push('angle brackets');
      if (problems.length) { bad++; console.error(p.id, asShorts ? 'shorts' : 'video', problems.join(', '), '|', r.title); }
    }
  }
  let ttBad = 0;
  for (const p of posts) for (const isVideo of [true, false]) {
    const r = seo.buildTikTokSeo(p.caption, p.tags, { isVideo });
    const problems = [];
    if (r.caption.length > 2200) problems.push('caption>2200');
    if (r.hashtags.length < 3 || r.hashtags.length > 5) problems.push('hashtags ' + r.hashtags.length);
    if (r.hashtags.some((t) => /^#(fyp|foryou|foryoupage|viral|trending|xyzbca)$/i.test(t))) problems.push('generic tag');
    if (!r.caption.slice(0, 100).toLowerCase().includes(r.primaryKeyword.toLowerCase().slice(0, 15))) problems.push('keyword not in first 100');
    if (!isVideo && !r.altText) problems.push('no alt text');
    if (problems.length) { ttBad++; console.error('tiktok', p.id, problems.join(', '), '|', r.primaryKeyword); }
  }
  assert.strictEqual(ttBad, 0, `${ttBad} TikTok results broke a rule`);
  assert.strictEqual(bad, 0, `${bad} generated results broke a hard limit`);
  n++;
  console.log(`Checked ${posts.length * 2} real results (${posts.length} captions x Shorts/video).`);
  if (process.argv.includes('--show')) {
    for (const id of ['18076618544226417', '18030708089854436', '18093950863916624']) {
      const p = posts.find((x) => x.id === id); if (!p) continue;
      const r = seo.buildYouTubeSeo(p.caption, p.tags, { asShorts: true, permalink: p.permalink });
      console.log('\n--- ' + id + '\nTITLE: ' + r.title + '\nTAGS: ' + r.tags.join(', ') + '\n' + r.description);
    }
  }
}
console.log(`${n} checks passed.`);
