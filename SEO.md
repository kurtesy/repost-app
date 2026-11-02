# YouTube SEO

The app now builds the search-facing fields of every YouTube upload with `server/services/seo.js`.
Turn it off with `YT_SEO_ENABLED=0` to get the old caption-based fields back.

## What the app does automatically

| Field | Rule | Where |
|---|---|---|
| Title | `[Primary keyword] \| [Benefit] \| [Format]`, keyword first, 70 characters max. Segments drop from the right before the keyword is cut. | `buildYouTubeSeo` |
| Description line 1 | Starts with the same keyword plus a benefit, 150 characters max. | `buildYouTubeSeo` |
| Description lines 2-4 | Short summary from the caption plus a sentence naming 2-3 related keywords. | `buildYouTubeSeo` |
| Description footer | Chapters (only with real timestamps), source credit with the Instagram link, links from `SEO_LINKS`, then at most 3 hashtags. `#Shorts` counts as one of the 3 for Shorts. | `buildYouTubeSeo` |
| Tags | 3-5 close variants of the keyword, under 450 characters in total (API cap is 500). | `buildYouTubeSeo` |
| Category | 19, Travel & Events (`SEO_CATEGORY_ID`). | `youtubeFields` in `workflow.js` |

The primary keyword is the first clause of the caption with filler openers removed ("Save this for
your Tenerife trip" becomes "Tenerife trip"). When that clause is vague it falls back to a venue
name found in the caption ("Ramla Bay Resort"), then to a place plus kind of venue ("Vienna Hotel").
Titles with a weak keyword log a warning and show it in the preview response.

## Checking and applying

- **Preview:** `GET /api/media/:id/preview?uploadAs=shorts|video` returns the generated fields plus `seo`
  details (keyword, hashtags, title length, warnings).
- **Fix a video that is already live:** `POST /api/youtube/videos/:videoId/seo` with
  `{ "mediaId": "<instagram id>", "uploadAs": "shorts", "dryRun": true }`. Remove `dryRun` to apply it
  with `videos.update` (50 quota units). Optional `primaryKeyword` and `chapters` override the defaults:
  `[{ "t": "0:00", "label": "Intro" }, { "t": "0:45", "label": "..." }, { "t": "2:10", "label": "..." }]`.
- **Tests:** `npm run test:seo` checks every caption in `instagram-metadata.json` against the hard limits
  (title, first line, hashtag count, tag size, no angle brackets).

Duplicate detection and "Sync with YouTube" compare against both the plain caption title and the SEO
titles, so videos uploaded with an optimised title are still recognised as already posted.

## Chapters

Chapters need 3 or more timestamps, the first at `0:00`, each at least 10 seconds apart. Reposted
Reels have no chapters, so none are written unless you supply real ones. Shorts do not use chapters.

## Captions

Call `youtube.uploadCaptions(videoId, '/path/file.srt', { language: 'en' })` to attach your own SRT or
VTT file (400 quota units). Otherwise let YouTube auto-generate captions and correct them in Studio.
Captions are indexed for search, so fixing the names of hotels and places matters most.

## What cannot be automated

- **Thumbnail and click-through rate.** High contrast, 3 words or fewer, one clear face or object.
  Click-through rate moves reach more than tags do. Shorts thumbnails are chosen in the app, not through
  the API. For regular videos, `thumbnails.set` can upload one; the app does not generate artwork.
- **Hook in the first 5 seconds.** Retention (watch time and average view duration) affects search and
  suggested rankings. Open on the strongest shot with the keyword on screen. Cut the intro.
- **On-screen text for Shorts.** Put the keyword in the first frame as well as the title.
- **Real keyword research.** The keyword comes from your caption. Before you publish, check that the
  phrase is something people type (YouTube search suggestions are free), and pass `primaryKeyword` when the
  caption is vague.
- **Captions with vague first lines.** About 3 in 10 captions in the current export open with a line like
  "This view and nothing else". Those get a venue name or place when one exists in the caption and a
  warning when none does.

---

# TikTok SEO

TikTok search reads the caption, the on-screen text, the spoken audio and the cover. `buildTikTokSeo` in
`server/services/seo.js` writes the caption and hashtags; the in-video items are returned as an exact
checklist per post. Turn it off with `TT_SEO_ENABLED=0` to get the old caption back.

## What the app does automatically

| Item | Rule |
|---|---|
| Caption | First sentence is `Keyword: benefit line.`, so the keyword sits inside the first 100 characters. The rest of the original caption follows, then hashtags. 2,200 characters max. |
| Hashtags | 3-5: one broad (`#traveltok` or `#foodtok`), two niche (venue or place, category tag such as `#hotelreview`), one branded (`SEO_BRAND_TAG`). Generic tags (`#fyp`, `#foryou`, `#viral`, `#xyzbca` and similar) are dropped. |
| Watch time | A warning when `durationSec` is over 15. |
| One niche | A warning when the post matches none of `SEO_NICHE_WORDS`. With `TIKTOK_NICHE_STRICT=1` the workflow skips it and logs `skipped_off_niche`. |

## Checking it

`GET /api/media/:id/preview?durationSec=22` (add `&type=image` for a photo or carousel). The `tiktok.seo`
block returns `primaryKeyword`, `hashtags`, `onScreenText`, `spokenHook`, `coverText`, `altText`,
`onNiche` and `warnings`. `npm run test:seo` runs the rules against every caption in the export.

## What cannot be automated (the preview tells you the exact words)

- **On-screen text.** Overlay `onScreenText` within the first 3 seconds. TikTok reads it for search.
  Reposted Reels need this added in the edit; the app does not burn text into video.
- **Spoken keyword.** TikTok transcribes speech. Say the keyword in the first sentence (`spokenHook`).
- **Cover image.** Pick a frame with readable text that matches `coverText`. The posting API used here has
  no cover or alt-text field, so these two are set in the TikTok app.
- **Alt text.** For photo posts and carousels, paste `altText` (100 characters max).
- **Under 15 seconds.** Completion rate and rewatches weigh heavily. Trim reposts and open on the hook.
- **One niche per account.** Keep the account to travel, stays and food. Edit `SEO_NICHE_WORDS` if that changes.

## Photo posts

`tiktok.postPhoto` now exists and sends the image through the same PM3K batch endpoint as videos, with the
SEO caption. PM3K's photo item format is not confirmed: it is sent as `media_type: "PHOTO"` with a
`source_url`. Test one post in draft or private first; if PM3K rejects it, set `PM3K_PHOTO_MEDIA_TYPE`.
Single images only; carousels are not supported by this call.

---

# Search-intent upgrade (YouTube and TikTok)

- **Keyword is what people search, not the hook.** Captions that open with a personal line ("The Grand Canyon
  humbled me", "I don't know if I can influence...") no longer become the title. The builder finds the place
  (a proper noun, favoured when a hashtag repeats it) and writes `Place + intent`: "Dubai Itinerary",
  "Berlin Restaurant Review", "Grand Canyon West Travel Guide". Venue names still win, and a clean short
  opening clause is still used as is. Pass `primaryKeyword` to override.
- **Category is scored**, not first-match, so one stray "room" in an itinerary no longer makes it a hotel review.
- **Titles** swap a repeated benefit for `<year> Tips` ("Dubai Travel Guide | 2026 Tips | Shorts").
- **YouTube tags** add "things to do in <place>" and "<place> hotel/restaurant/travel", and no longer produce
  doubled words ("guide guide") or tags from vague hashtags. The preview returns `place` and a `pinnedComment`
  question to pin by hand (the app has no comment-posting scope).
- **TikTok** hashtags lead with the place (`#dubai`, `#dubaitravel`), never come from a personal hook, and drop
  community-style tags (`#igtraveller`, `#travelcommunity`, `#coupletravelgoals`). Every caption ends with
  "Save this for your <place> trip." because saves and comments weigh in ranking.
