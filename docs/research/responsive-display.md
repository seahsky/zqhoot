# Responsive display: projector, phone and host views (research for zqhoot)

Accessed: 2026-09-29. Purpose: evidence and numbers for one React app that serves a projector presenter view (16:9, 10+ m away), a phone player view (320 px minimum, one hand) and laptop host/editor views. Nothing here copies Kahoot or Mentimeter styling.

## How this evidence was gathered (read first)

- WebFetch returned EGRESS_BLOCKED for developer.mozilla.org, web.dev, caniuse.com, playwright.dev, www.avixa.org, risertools.com and visualdisplaysltd.com (one attempt each, not retried). The WebSearch budget (200 calls, session-wide) ran out partway through, so sections 1 and 3 have gaps that are marked "Not verified".
- After that I read primary documents from public GitHub raw files and package registries that the proxy allowed: the W3C `w3c/wcag` repo (spec source, Understanding docs, techniques), `mdn/content`, Chrome and web.dev doc sources, `microsoft/playwright` docs, plus npm/PyPI packages. WCAG text below is the spec source in W3C's own repository, not the rendered www.w3.org page.
- Browser support numbers come from the npm packages `@mdn/browser-compat-data` 8.1.3 [6] and `caniuse-db` 1.0.30001813 (dataset updated 2026-09-28) [7], queried locally.
- Tags: **[primary]** = W3C, MDN, vendor docs, standards body, package data. **[primary via search summary]** = a standards-body page I only saw through the WebSearch tool's summary, not verbatim. **[secondary]** = third-party. **Inference:** = my reasoning or design proposal. **Unverified (background knowledge)** = from memory, unsourced. All contrast and colour-difference numbers were computed by me (WCAG formula [2]; CIEDE2000 via `culori` 4.0.2); the scripts live in the session scratchpad, not the repo.

## Key findings

1. **Distance rule.** AVIXA's Display Image Size standard (DISCAS) uses an acuity factor of 200 for basic decision making, which reduces to: farthest viewer distance = image height x (element height as a fraction of image height) x 200 [17][primary via search summary]. That reproduces the 4-6-8 rule at 2%, 3% and 4% element height (my arithmetic, section 1.1).
2. **Inference:** for a 2.5-3.0 m wide screen viewed from 10 m (6-7 screen heights away), essential text should be about 4.3-5.0% of stage height in font size (46-54 px at 1080p). What DISCAS counts as "element height" is unresolved in my sources, so the plausible range is 3.0-6.0% at 6 heights.
3. **Ambient light caps contrast.** If a lit room adds luminance `a` (fraction of projector white) to every pixel, the best possible ratio is (1+a)/a: 21:1 at a=0.05, 6:1 at a=0.2. Under that model a 4.5:1 pair falls to 3.2:1. **Inference:** projector essential text should be at least 15:1 nominal, secondary at least 10:1.
4. **Presenter scaling.** Use a 16:9 stage that is a size container and size everything in `cqh` (1% of stage height). 1366x768, 1920x1080 and 3840x2160 then give identical composition (1u = 7.68, 10.8, 21.6 px). Container query units work from Safari 16, Chrome 105, Firefox 110 [6][7].
5. **Resize-text caveat.** WCAG technique F94 says text sized mainly in viewport units is likely to fail 1.4.4, and names on-page size controls and media-query steps as acceptable [4]. So: viewport/stage units only in the presenter view (with an author "text size" control); rem units on phones and host views.
6. **Phone platform facts.** `dvh`/`svh`/`lvh` need iOS Safari 15.4; `env(safe-area-inset-*)` needs 11.3; `touch-action: manipulation` is full from iOS 13 (9.3 partial); Screen Wake Lock is iOS Safari 16.4 but did not work in Home Screen web apps until 18.4 and needs HTTPS; `navigator.vibrate` is not supported in iOS Safari [5][6][7].
7. **320 px layout.** A 2x2 answer grid leaves 138 px tiles (about 12 characters per line at 18 px); a stacked list leaves about 24. **Inference:** stack by default, use 2x2 only for short answers and wider containers.
8. **Tap targets.** WCAG 2.2 AA is 24x24 CSS px (or spacing), AAA is 44x44 [1]; Apple is 44 pt and Material 48 dp per Flutter's constants [16]. **Inference:** 48 px minimum, 72 px answer rows.
9. **Timed questions (2.2.1).** A live, shared countdown plausibly fits the "real-time event" exception, but an assessor could say an alternative exists. **Inference:** do not rely on it; give hosts untimed questions and per-player time multipliers, which W3C's own Understanding text endorses ("a third party can control the time limits", e.g. double time on a test) [3].
10. **WCAG 2.2 additions that bite here:** 2.4.11 focus not obscured (sticky bars), 2.5.7 dragging alternatives (ranking questions), 2.5.8 target size, 3.3.7 redundant entry, 3.3.8 accessible authentication (host sign-in). 4.1.1 Parsing is obsolete and removed [1].
11. **Colour.** Four Okabe-Ito colours (blue, vermillion, yellow, bluish green) keep a minimum CIEDE2000 difference of 10.7 (tritan A/D) and 17.4 (protan B/D) in my simulation, but vermillion and green differ by only 1.13:1 in luminance, so shape plus letter plus position must carry identity.
12. **Original shapes:** A hexagon, B plus, C five-point star, D dome (half-disc), each with letters A-D. None is Kahoot's triangle, diamond, circle or square.
13. **Answer text is ink on a neutral card;** colour fills only the shape glyph and chart bar, each with a 3-4 px ink outline. This keeps every essential element at 15:1+ and satisfies 1.4.11 regardless of fill.
14. **Testing.** Six Playwright projects (320x568, 390x844, 768x1024, 1366x768, 1920x1080, 3840x2160) plus `@axe-core/playwright` 4.13.0 with tags `wcag2a, wcag2aa, wcag21a, wcag21aa, wcag22aa` [11][13]. Playwright's iPhone 12/13/14 descriptors use a 390x664 viewport, so 390x844 must be set explicitly [12].
15. **Not verified:** Hoober's thumb-zone studies, iOS input zoom below 16 px, projector polarity (dark-on-light vs light-on-dark), saturated red/blue on projectors, safe-margin conventions, ANSI/INFOCOMM 3M contrast classes, exact CVD prevalence, direct Apple HIG and Material pages. See the last section.

## 1. Projector legibility

### 1.1 Text size versus distance

- DISCAS (ANSI/INFOCOMM V202.01:2016) sets image size and viewer positions for two viewing needs, basic and analytical decision making, derived from ANSI/INFOCOMM 3M-2011 [17][primary via search summary]. AVIXA's calculator pages give the acuity factor as 200 for basic and 3438 for analytical, and define an "element" as a group of pixels conveying an item of information [17][primary via search summary].
- The basic formula, as relayed by a search summary of AVIXA calculator pages: farthest viewer = image height x %element height x 200 [17][primary via search summary]. The analytical formula is farthest viewer = image height x 3438 / vertical resolution [17][primary via search summary], so pixel count limits detail-heavy content; not a concern for quiz text.
- The 4-6-8 rule says the farthest viewer should sit at most 4, 6 or 8 image heights away for analytical, general-presentation and passive viewing [19][secondary]. **Inference (arithmetic on [17]):** with factor 200 these are 2%, 3% and 4% element height, so general presentation (text, slides) is 3% at 6 heights.
- A separate rule of thumb: character height should be at least 1/200 of viewing distance, quoted as 20 arcminutes and traced to the FAA; presentation minimums of 5 arcminutes (minimum) and 7 arcminutes (good) are also quoted [20][secondary]. The same summary's worked example (10 m gives 40 mm) does not match 1/200 (50 mm), so treat that page's numbers with caution.
- "Element height" is ambiguous. One blog says a lowercase "e" in 11 pt text on a 1080 source is 6 px, i.e. 0.5% element height [21][secondary]; another summary says DISCAS BDM with 1080 lines and 20 pt type gives a factor of 5 [22][secondary], which fits element height being roughly the font size (20 pt = 26.7 px = 2.5%, times 200 = 5). Typical font proportions are quoted as cap height about 70% and x-height about 48% of the em [23][secondary].

**Inference: converting to stage units** (u = 1% of stage height; computed):

| Farthest viewer / image height | Element height | Font size if element = font size | if element = cap height (0.70 em) | if element = x-height (0.5 em) |
|---|---|---|---|---|
| 4 | 2.0% | 2.0u | 2.9u | 4.0u |
| 6 | 3.0% | 3.0u | 4.3u | 6.0u |
| 7 | 3.5% | 3.5u | 5.0u | 7.0u |
| 8 | 4.0% | 4.0u | 5.7u | 8.0u |

A 2.5 m wide 16:9 image is 1.41 m tall, so 10 m is 7.1 heights; 3.0 m wide is 5.9 heights; 4.0 m wide is 4.4 heights (computed). I adopt the cap-height reading (it matches the 1/200 character-height rule): minimum font size in u is about 0.714 x (distance / image height).

### 1.2 Weight and family

- WCAG's definition of large-scale text warns that "fonts with extraordinarily thin strokes or unusual features and characteristics that reduce the familiarity of their letter forms are harder to read, especially at lower contrast levels" [2][primary]. That is the only sourced font guidance I found.
- **Inference:** use one sans family with a large x-height and open counters; body weight 500-600, headings 700-800, never below 400. Use `font-variant-numeric: tabular-nums` for countdowns, scores and counts so digits do not jitter (supported since Safari 9.1, Chrome 52, Firefox 34 [6][primary]). Named projector-safe font families: Not verified.

### 1.3 Contrast on projectors

- WCAG defines contrast ratio as (L1 + 0.05) / (L2 + 0.05) [2][primary]. AA text is 4.5:1 (3:1 large); AAA (1.4.6) is 7:1 (4.5:1 large) [1][primary].
- **Inference (simple model):** a lit room adds ambient luminance `a` (as a fraction of projector white) equally to every pixel, so effective ratio = (Lfg + a)/(Lbg + a). Computed:

| Pair (nominal WCAG ratio) | a = 0.05 | 0.10 | 0.20 | 0.30 |
|---|---|---|---|---|
| Ink #0B1020 on white (18.93) | 18.93 | 10.43 | 5.84 | 4.26 |
| Ink-2 #3A4258 on white (10.00) | 10.00 | 7.10 | 4.71 | 3.66 |
| Ink on yellow #F0E442 (14.32) | 14.32 | 8.00 | 4.59 | 3.42 |
| White on blue #0072B2 (5.19) | 5.19 | 4.36 | 3.40 | 2.87 |
| Ink on vermillion #D55E00 (4.90) | 4.90 | 3.05 | 2.05 | 1.71 |
| #767676 on white (4.54, AA minimum) | 4.54 | 3.91 | 3.15 | 2.70 |
| Ceiling (1+a)/a | 21.0 | 11.0 | 6.0 | 4.33 |

- Consequences: mid-luminance fills with text on them collapse first; only maximum-luminance-difference pairs survive. Rule: essential text at least 15:1 nominal, secondary text at least 10:1, and no essential information printed on mid-luminance fills. The `a` values are illustrative; I did not find measured ambient fractions (Unverified: screen illuminance from room lighting is typically 10-30% of projector white in a lit meeting room).
- In this model polarity does not change the ratio (it is symmetric), so dark-on-light versus light-on-dark is decided by other effects (glare, adaptation, halation). I found no source. **Not verified.** **Inference:** ship both a light stage (default for lit rooms) and a dark stage (dim rooms) with a host toggle, both at 17:1+ (ink #0B1020 on #FFFFFF = 18.93; #F4F6FB on #0B1020 = 17.51).
- Projected-image contrast classes from ANSI/INFOCOMM 3M-2011 exist [17][primary via search summary] but I could not read the numbers. **Not verified.**

### 1.4 Saturated reds and blues; safe margins

- No source found for projectors rendering pure saturated red or blue poorly. **Not verified** (searched: none before the budget ended). **Inference:** avoid #FF0000 and #0000FF fills; the proposed Okabe-Ito colours are none of those.
- WCAG defines a red flash as a transition to or from a state with R/(R+G+B) >= 0.8 [2][primary], so red pulsing on a huge projected area is doubly risky.
- Safe margins: no source. Unverified (background knowledge): broadcast "title-safe" is about the inner 90%. **Inference:** keep essential content inside the inner 90% on both axes (5% each side) because some TVs and projector modes crop or keystone.

## 2. Scaling one layout from 1366x768 to 3840x2160

### 2.1 Building blocks

- `clamp(min, preferred, max)` clamps a value between bounds [5][primary]; supported Safari 13.1, Chrome 79, Firefox 75 [6][primary].
- `vh`/`vw` are 1% of the viewport height/width; `vmin`/`vmax` the smaller/larger. All default viewport units currently equal their large-viewport (`lv*`) counterparts [5][primary]. Small (`sv*`) sizes assume browser UI expanded, large assumes retracted, dynamic (`dv*`) follows it [8][primary]. Dynamic units resize while scrolling and are throttled, and viewport units ignore classic scrollbars and the on-screen keyboard [5][8][primary]. Support: Safari/iOS 15.4, Chrome 108, Firefox 101 [6][primary]; about 95.0% global usage [7][primary].
- Container queries and units (`cqw`, `cqh`, `cqi`, `cqb`): container-type `size` applies layout, style and size containment; units default to the small viewport if no container exists [5][primary]. Support: Safari 16, Chrome 105, Firefox 110 [6][primary]; about 94.8% global usage (caniuse marks Chrome 105 partial for a multicolumn-table bug, full at 106) [7][primary].

### 2.2 Fixed transformed stage versus fluid

| | Fixed 1920x1080 stage, `transform: scale()` | Fluid layout in stage units (`cqh`) |
|---|---|---|
| Composition at every size | Pixel-identical | Identical if 16:9 letterboxed |
| Needs JS | Yes, to get a unitless scale (I did not verify that dividing two lengths in `calc()` is baseline, so avoid) | No |
| Text rendering | Rasterised/scaled | Native, crisp |
| Reflow for odd aspect ratios | None; letterbox only | Same letterbox; components may also reflow |
| Reuse in host preview thumbnail | Awkward | Natural: any container gets the same unit |
| Zoom/resize text (1.4.4) | Breaks; scale cancels zoom | Also cancels zoom (F94 [4]); needs on-page size control |

**Inference:** choose fluid `cqh` for the presenter stage, keep a `min(1vh, 0.5625vw)` fallback for pre-2022 browsers, and use no scaling at all on phones.

### 2.3 Same composition at 4K, not tiny text

```css
.stage-frame { display: grid; place-items: center; min-height: 100vh; background: var(--letterbox); }
.stage       { container-type: size; aspect-ratio: 16 / 9;
               width: min(100vw, calc(100vh * 16 / 9)); }
.stage__body { --u: min(1vh, 0.5625vw); }                 /* fallback */
@supports (height: 1cqh) { .stage__body { --u: 1cqh; } } /* 1% of stage height */
.q   { font-size: calc(var(--u) * 7); }
```

`--u` is declared on a child because a container's own container units resolve against an outer container. At 768, 1080 and 2160 px stage heights 1u is 7.68, 10.8 and 21.6 px, so a 5u answer is 38, 54 and 108 px (computed). CSS px are what count: a 4K TV at device pixel ratio 2 is 1920x1080 CSS px, and Playwright can emulate that with `deviceScaleFactor` [11].

- **F94:** "viewport units applied to text ... prevent most available methods" of resizing; "If media queries were used to adjust the size of text ... it may not be a failure ... On-page controls provided by the author are also a way of passing" [4][primary]. **Inference:** ship a presenter/host "Text size" control (100/125/150%) multiplying `--u`, and never use `user-scalable=no`.
- Host and editor views: rem-based, with step media queries rather than continuous vw: root font-size 100% up to 2559 CSS px, then 133% (2560), 167% (3200), 200% (3840). Do not use `100vw` for widths (scrollbars are ignored, so it overflows) [8][primary].

## 3. Phone player view

### 3.1 Thumb zone

- W3C's Understanding docs for 2.5.8 and 2.5.5 cite the study "One-Handed Thumb Use on Small Touchscreen Devices" (Parhi, Karlson, Bederson 2006) as a resource but I did not read it [3][primary]. Steven Hoober's studies: **Not verified** (not reachable; search budget ended). Unverified (background knowledge): Hoober's 2013 observation study reported about half of touches as one-handed thumb use, with the lower-middle screen easiest and top corners hardest to reach.
- **Inference:** question and timer at the top (read-only); answers in the lower 60% of the viewport; no critical tap targets in top corners; leave 16 px gutters so edge swipes are not triggered by thumb rest.

### 3.2 Portrait layout: 2x2 versus stacked at 320 px

Computed with 16 px gutters, 12 px gap, 12 px tile padding, 18 px text at an assumed 0.5 em average glyph width:

| Viewport | 2x2 tile width | chars/line (2x2) | Stacked row width | chars/line (stacked, 44 px badge) |
|---|---|---|---|---|
| 320 | 138 | about 13 | 288 | about 24 |
| 390 | 173 | about 17 | 358 | about 31 |
| 768 | 362 | about 38 | 736 | about 73 |

Four stacked rows at 72 px with 12 px gaps need 324 px of height. **Inference:** stack by default when the phone shows answer text; switch to 2x2 by container query (about 420 px wide) only when every answer is 24 characters or fewer or is an image. Keep DOM order A, B, C, D in both layouts so focus order matches visual order (2.4.3) [1].

### 3.3 Zoom, viewport meta, double-tap

- iOS input zoom: Unverified (background knowledge) that iOS Safari zooms into focused text inputs whose computed font-size is below 16 px. Not sourced. **Inference:** all inputs at least 16 px (1rem); never "fix" it with `maximum-scale=1`: MDN warns that `user-scalable=no` "prevents people experiencing low vision conditions from being able to read", WCAG needs at least 2x scaling, and iOS 10+ ignores it by default [5][primary]; axe flags it (`meta-viewport`, tagged wcag144) [13][primary].
- Use `<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">`. `viewport-fit=cover` fills the display and MDN "highly recommends" the safe-area insets so content is not cut off [5][primary]. `env(safe-area-inset-*)` works from iOS Safari 11.3 (11.0-11.2 used `constant()`) and Chrome 69 [6][7][primary].
- `touch-action: manipulation` "enable[s] panning and pinch zoom gestures, but disable[s] additional non-standard gestures such as double-tap to zoom" and removes the click delay [5][primary]. iOS Safari: 9.3 (only `auto` and `manipulation`), full from 13 [6][7][primary]. Pinch zoom stays available, so 1.4.4 is not harmed.
- Keyboard: `interactive-widget=resizes-content` is Chrome for Android 108 only; iOS Safari has no support [6][primary], and the on-screen keyboard does not change viewport units [8][primary]. Keep the join input and its Join button high enough to stay visible above the keyboard.

### 3.4 `100vh`, `dvh` and safe areas

- On mobile, `100vh` "will bleed out of the viewport" on load because dynamic toolbars are not counted [8][primary]. **Inference:** `min-height: 100vh; min-height: 100svh;` for page shells (never hidden under toolbars), `dvh` only for full-bleed backgrounds, because dynamic units change during scroll [5][8][primary].
- Pad fixed bars: `padding-bottom: calc(1rem + env(safe-area-inset-bottom))` as in MDN's example [5][primary].

### 3.5 Haptics and Screen Wake Lock

| API | iOS Safari | Android Chrome | Notes |
|---|---|---|---|
| `navigator.vibrate` | Not supported (no version) [6][7] | 32 [6] | Needs user activation, silent mode can suppress it, no effect if no hardware [5]; Firefox Android 79 "partial": returns true, does not vibrate [6]; about 79% global usage [7] |
| Screen Wake Lock | 16.4 in Safari; 16.4-18.3 "Does not work in standalone Home Screen Web Apps" (WebKit bug 254545), full 18.4 [6] (caniuse lists 16.4) [7] | 84 (caniuse: 85) [6][7] | Secure context only (MDN's page carries the secure-context banner); may be released when the document is hidden; MDN lists "presenting to an audience" as a use case [5] |

**Inference:** haptics are optional garnish behind `'vibrate' in navigator`; every state ("Answer locked") also needs a visual and text signal. A self-hosted LAN deployment over plain `http://` will lose Wake Lock on phones and on the presenter laptop, so document HTTPS (or `localhost`) as a deployment requirement.

## 4. Tap target sizes

- WCAG 2.2 SC 2.5.8 Target Size (Minimum), Level AA: "The size of the target for pointer inputs is at least 24 by 24 CSS pixels, except when:" Spacing: "Undersized targets (those less than 24 by 24 CSS pixels) are positioned so that if a 24 CSS pixel diameter circle is centered on the bounding box of each, the circles do not intersect another target or the circle for another undersized target"; also Equivalent, Inline, User Agent Control and Essential exceptions [1][primary]. Understanding: 20x20 px targets with 4 px gaps pass; 20x20 with no gap fail; the rule is independent of page zoom [3][primary].
- WCAG 2.2 SC 2.5.5 Target Size (Enhanced), Level AAA: "The size of the target for pointer inputs is at least 44 by 44 CSS pixels except when:" Equivalent, Inline, User Agent Control, Essential [1][primary]. Understanding recommends larger sizes for frequent, hard-to-undo, hard-to-reach or sequential-task controls [3][primary]: a quiz answer is all four.
- Apple: 44 pt; Material: 48 dp. I could not read Apple's HIG or Material pages. Flutter's framework constants say `kMinInteractiveDimension = 48.0` ("according to Material guidelines") and `kMinInteractiveDimensionCupertino = 44.0` ("according to Apple human interface guidelines") [16][secondary]. W3C's Understanding lists both as resources [3][primary]. Direct quotes: **Not verified.**
- **Inference:** minimum 48x48 CSS px for every interactive control (meets AAA and both platforms), 72 px rows and 12 px gaps for answers, 8 px minimum gap between any two targets.

## 5. WCAG 2.2 AA criteria that apply

Quotes are from the spec source [1] unless noted; levels from the same files. Only quoted where wording matters.

| SC | Applies to zqhoot |
|---|---|
| 1.1.1 Non-text Content (A): "All non-text content that is presented to the user has a text alternative that serves the equivalent purpose" | Shape glyphs decorative (`aria-hidden`); charts get a text or table alternative (section 7). |
| 1.3.1 Info and Relationships (A): "Information, structure, and relationships conveyed through presentation can be programmatically determined or are available in text." | Real headings, lists for answers, `<table>` for leaderboard, labels tied to inputs. |
| 1.3.4 Orientation (AA): "Content does not restrict its view and operation to a single display orientation ... unless a specific display orientation is essential." The SC text lists "slides for a projector or television" as an example of essential | Presenter view may be landscape only; player, host and editor views must work in both. |
| 1.4.1 Use of Color (A): "Color is not used as the only visual means of conveying information, indicating an action, prompting a response, or distinguishing a visual element." | Answer identity = letter + shape + position + colour; correct/incorrect = icon + text; chart series = labels. |
| 1.4.3 Contrast (Minimum) (AA): 4.5:1, "Large-scale text ... 3:1"; large scale is "at least 18 point or 14 point bold" [2]. Understanding: 14/18 pt is about 18.5/24 CSS px (1 pt = 1.333 px) [3] | All text 4.5:1+; projector target far higher (section 1.3). |
| 1.4.4 Resize Text (AA): "text can be resized without assistive technology up to 200 percent without loss of content or functionality" | See F94 caveat (2.3); never block browser zoom on phones. |
| 1.4.10 Reflow (AA): "without requiring scrolling in two dimensions for: Vertical scrolling content at a width equivalent to 320 CSS pixels", except content needing 2-D layout; examples include "games, presentations" | Player/host/editor reflow at 320; the presenter stage is a presentation, but keep it free of horizontal scroll. |
| 1.4.11 Non-text Contrast (AA): 3:1 against adjacent colours for "Visual information required to identify user interface components and states" and "Parts of graphics required to understand the content" | 3-4 px ink outline on answer cards, badges and bars; ink vs white is 18.93:1. Values are not rounded (2.999 fails) [3]. |
| 1.4.12 Text Spacing (AA): no loss when line height is 1.5x, paragraph spacing 2x, letter spacing 0.12x, word spacing 0.16x the font size | No fixed-height text boxes in host/editor/player; the stage may clip only if it auto-shrinks. |
| 1.4.13 Content on Hover or Focus (AA): dismissible, hoverable, persistent | Editor and host tooltips. Not used on phones. |
| 2.1.1 Keyboard (A): "All functionality of the content is operable through a keyboard interface" | Host controls, editor, ranking reorder, and 1-4 / A-D keys on laptops. |
| 2.2.1 Timing Adjustable (A) | See 5.1. |
| 2.2.2 Pause, Stop, Hide (A) | See 5.2. |
| 2.3.1 Three Flashes or Below Threshold (A): "Web pages do not contain anything that flashes more than three times in any one second period, or the flash is below the general flash and red flash thresholds." | No flashing countdown, confetti or podium strobing; the area threshold is 0.006 sr within any 10 degree field [2], easy to exceed on a projector. |
| 2.4.3 Focus Order (A) | DOM order = visual order in 2x2 and stacked layouts. |
| 2.4.7 Focus Visible (AA) | 4 px outline plus 3 px offset in `--ink`, visible on every fill. |
| 2.4.11 Focus Not Obscured (Minimum) (AA, new): "the component is not entirely hidden due to author-created content" | Sticky timer bar or bottom safe-area bar must not hide the focused answer: technique C43 (`scroll-padding`) and failure F110 [4]. `scroll-padding-block` support: Safari 15, Chrome 69, Firefox 68 [6]. |
| 2.5.3 Label in Name (A): "the name contains the text that is presented visually" | Let visible "A" plus answer text form the accessible name; do not override with a different `aria-label`. |
| 2.5.7 Dragging Movements (AA, new): "All functionality that uses a dragging movement for operation can be achieved by a single pointer without dragging" | Ranking question: up/down buttons or tap-to-place beside drag. |
| 3.2.1 On Focus (A), 3.2.2 On Input (A): "Changing the setting of any user interface component does not automatically cause a change of context unless the user has been advised" | Tell players "Tap an answer to lock it in" before the question; selecting must not navigate. |
| 3.2.3 Consistent Navigation, 3.2.4 Consistent Identification (AA), 3.2.6 Consistent Help (A, new) | Same letter/shape/colour per position across all questions; help link in the same place. |
| 3.3.1 Error Identification (A): "the item that is in error is identified and the error is described to the user in text"; 3.3.2 Labels or Instructions (A) | PIN and nickname errors in text ("No game with that PIN"), visible labels. |
| 3.3.7 Redundant Entry (A, new): "auto-populated, or available for the user to select" | Remember nickname on reconnect; do not re-ask PIN or question data within one flow. |
| 3.3.8 Accessible Authentication (Minimum) (AA, new): "A cognitive function test ... is not required for any step in an authentication process unless" Alternative, Mechanism, Object Recognition or Personal Content | Host sign-in: allow paste and password managers, offer passkey or emailed link; no puzzle CAPTCHA. Understanding says it covers logging in to an existing account, not account creation; a player's PIN entry is not obviously in scope, but offer QR and link join anyway [3]. |
| 4.1.2 Name, Role, Value (A) | Native `<button>`, `<input>`; custom radio/ranking widgets get ARIA. |
| 4.1.3 Status Messages (AA): "status messages can be programmatically determined through role or properties such that they can be presented to the user by assistive technologies without receiving focus" | "Answer received", "12 of 30 answered", "Time is up": `role="status"` (polite). |

**4.1.1 Parsing is obsolete and removed in WCAG 2.2** (verified): the source file reads "Parsing (Obsolete and removed) ... This criterion no longer has utility and is removed." [1][primary].

### 5.1 2.2.1 Timing Adjustable and a live timed quiz

Exact wording [1][primary]: "For each time limit that is set by the content, at least one of the following is true:" Turn off; Adjust ("over a wide range that is at least ten times the length of the default setting"); Extend ("given at least 20 seconds to extend the time limit with a simple action ... at least ten times"); **"Real-time Exception: The time limit is a required part of a real-time event (for example, an auction), and no alternative to the time limit is possible"**; **"Essential Exception: The time limit is essential and extending it would invalidate the activity"**; 20 Hour Exception.

Definitions [2][primary]: "real-time event: event that a) occurs at the same time as the viewing and b) is not completely generated by the content" (examples: a webcast, an online auction with people bidding, live humans in a virtual world); "essential: if removed, would fundamentally change the information or functionality of the content, and information and functionality cannot be achieved in another way that would conform". Understanding gives the auction rationale: the limit "applies to all users who want to bid on a particular item, so it would be unfair to extend the time limit for any one particular user"; and "In cases where timing is not an intrinsic requirement but giving users control over timed events would invalidate the outcome, a third party can control the time limits for the user (for example, granting double time on a test)" [3][primary].

**Inference (decision):**
- Live synchronous mode (host advances questions, everyone races one countdown, players compete with other live humans): treat as a real-time event. Its structure matches the auction example (fairness across bidders, outcome depends on other live people). Not a guaranteed pass: "no alternative to the time limit is possible" can be argued against, because a host could pause or extend for everyone.
- So do not rely on the exception alone. Provide (1) a per-question "no time limit, host advances" option, (2) generous default limits, (3) host-set per-player time multipliers (x1.5, x2), the third-party control model above, and (4) in any self-paced/asynchronous mode, which is not a real-time event, a per-player adjustable limit (turn off, or at least 10x).
- I found no case law or regulator guidance on quizzes; legal interpretation is **Not verified.**

### 5.2 2.2.2 Pause, Stop, Hide (countdowns and live boards)

Wording [1][primary]: moving/blinking/scrolling content that starts automatically, lasts more than five seconds and is presented in parallel with other content needs "a mechanism for the user to pause, stop, or hide it unless the movement ... is part of an activity where it is essential"; for "auto-updating information" likewise "or to control the frequency of the update unless the auto-updating is part of an activity where it is essential". Understanding lists "real-time games" among moving content and "an auction timer" as content where pausing would mislead [3][primary].

**Inference:** the countdown is essential to the activity, but add mechanisms anyway: host pause; a player option to hide timer visuals (keep a coarse text status via `role="status"` every 10 s and at 5 s remaining); under `prefers-reduced-motion: reduce`, a numeric countdown updating once per second with no sweeping or scaling animation. Live answer counts on the presenter view: update at most once per second, and let the host freeze them. Leaderboard reorders once per reveal, not continuously.

### 5.3 Media queries

- `prefers-reduced-motion: reduce` "minimize[s] the amount of non-essential motion"; scaling and panning of large objects can trigger vestibular disorders [5][primary]. Support: Safari iOS 10.3, Chrome 74, Firefox 63 [6][primary].
- `prefers-contrast`: `more`, `less`, `no-preference`, `custom` [5][primary]; Safari iOS 14.5, Chrome 96, Firefox 101 [6][primary]. **Inference:** `more` switches to 7:1+ ink, thicker outlines and drops tinted fills. `forced-colors` is supported in iOS Safari 16 and Chromium/Firefox [6]; keep outlines as real borders so shapes survive.

## 6. Colour-blind-safe answer differentiation

### 6.1 Prevalence and method

- Chrome's DevTools team: "Roughly 1 in 20 people suffer from a color vision deficiency" (citing Colour Blind Awareness, not fetched) [10][secondary]. Unverified (background knowledge): about 8% of men and 0.5% of women, mostly red-green. I have no primary source for a precise figure.
- MDN: luminance contrast "enables the development of content that even those with color blindness can see" [5][primary]. That is why identity must not depend on hue alone.

### 6.2 Published CVD-oriented palettes

Okabe-Ito (Masataka Okabe and Kei Ito, "Color Universal Design"): hex values as encoded in R's `palette.colors()` [14][secondary; original page not fetched]:
black #000000, orange #E69F00, sky blue #56B4E9, bluish green #009E73, yellow #F0E442, blue #0072B2, vermillion #D55E00, reddish purple #CC79A7 (R also lists gray #999999). A second implementation carries the same eight values [14][secondary].

Paul Tol qualitative sets, from the package he co-authors (`tol_colors` 2.2.0, "Colorsets and colormaps designed by PT"; docs cite "Colour Schemes", SRON/EPS/TN/09-002, issue 3.2, 2021) [15][primary, author-maintained package; SRON note not fetched]:
- Bright: #4477AA blue, #EE6677 red, #228833 green, #CCBB44 yellow, #66CCEE cyan, #AA3377 purple, #BBBBBB grey.
- Vibrant: #EE7733 orange, #0077BB blue, #33BBEE cyan, #EE3377 magenta, #CC3311 red, #009988 teal, #BBBBBB grey.
- Muted: #CC6677, #332288, #DDCC77, #117733, #88CCEE, #882255, #44AA99, #999933, #AA4499, pale grey #DDDDDD.
- High-contrast: #004488, #BB5566, #DDAA33 (plus black and white), which works in monochrome.
The package docs say sets were checked with red-blind and green-blind simulation and CIEDE2000 distances, and call Bright, Vibrant and Muted "colorblind-safe" [15][primary].

### 6.3 Testing tools

Chrome DevTools, Rendering tab, "Emulate vision deficiencies": blurred vision, reduced contrast, protanopia, deuteranopia, tritanopia, achromatopsia [9][primary]. It is based on the Machado, Oliveira and Fernandes model; the deuteranopia matrix Blink uses is 0.367 0.861 -0.228 / 0.280 0.673 0.047 / -0.012 0.043 0.969 [10][primary]. Firefox's Accessibility Inspector also simulates them [5][primary].

### 6.4 Proposal: shapes, letters, colours (Inference)

| Answer | Letter | Shape (24x24 viewBox) | Fill (Okabe-Ito) |
|---|---|---|---|
| A | A | Hexagon, points `12,2 20.66,7 20.66,17 12,22 3.34,17 3.34,7` | Blue #0072B2 |
| B | B | Plus (equal arms), `M9 2h6v7h7v6h-7v7H9v-7H2V9h7z` | Vermillion #D55E00 |
| C | C | Five-point star, `12,2 14.47,8.6 21.51,8.91 15.99,13.3 17.88,20.09 12,16.2 6.12,20.09 8.01,13.3 2.49,8.91 9.53,8.6` | Yellow #F0E442 |
| D | D | Dome (half-disc, flat side down), `M2 18a10 10 0 0 1 20 0z` | Bluish green #009E73 |

Each combination avoids Kahoot's triangle, diamond, circle and square. Position redundancy: A B over C D, or A to D top to bottom.

Computed contrast (WCAG formula [2]): ink #0B1020 on white 18.93:1; fills against white: A 5.19, B 3.87, C 1.32, D 3.42; against #0B1020: A 3.65, B 4.90, C 14.32, D 5.53. C fails 3:1 on white by itself, which is why every glyph and bar carries a 3-4 px ink outline (ink vs white 18.93:1).

CIEDE2000 differences between fills (my simulation: LMS dichromat matrices from `@bjornlu/colorblind` 1.0.3 in linear RGB; deuteranopia cross-checked with Chrome's matrix, minimum pair 20.5):

| Vision | AB | AC | AD | BC | BD | CD |
|---|---|---|---|---|---|---|
| Normal | 49.6 | 70.4 | 38.4 | 43.7 | 54.4 | 38.0 |
| Protan | 57.7 | 70.7 | 42.0 | 30.0 | 17.4 | 29.1 |
| Deutan | 64.2 | 75.4 | 36.3 | 22.4 | 22.0 | 35.5 |
| Tritan | 52.3 | 50.6 | 10.7 | 31.6 | 52.8 | 44.7 |

Achromatopsia: luminance ratios B/D 1.13:1, A/B 1.34:1, A/D 1.52:1, so those pairs are effectively identical without shape. Among all 4-colour subsets of seven Okabe-Ito hues, blue/yellow/vermillion/bluish green was the best of the hue-distinct sets (worst pair 10.7, from tritan A/D; the numerically best set had two blues). No accepted pass mark exists for these differences (Unverified: about 10 or more is "clearly different"); validate with DevTools and real users.

## 7. Charts on a projector

- Sourced: charts need a text alternative (1.1.1) [1]; graphical parts need 3:1 against adjacent colours (1.4.11) [1]; colour must not be the only distinguishing means (1.4.1) [1]; W3C guidance says a bar-chart alternative pairs a short label with a longer description of the data, trends and implications (as summarised in search results for WAI complex-image guidance, [24][primary via search summary]); status text such as "18 results returned" counts as a status message, and a persistent count changing from "0 items" to "3 items" is a new status message [3][primary].
- **Inference (unsourced):** direct-label bars ("A [hexagon] Paris  14  47%") instead of a legend, so the eye never leaves the bar. Show count and percentage: counts are what people compare, percentages survive different group sizes. Labels at least 4.5u; totals at 6u. Bars: horizontal, sorted by answer letter (stable, not by value) and 5-6u thick, with the ink outline. No gradients, gridlines or 3D. Bars begin at zero. Reveal correct answers with a "Correct" text label and check mark, and by outline thickness, not colour.
- Accessible alternative: a visually hidden `<table>` (Answer, Count, Percent) or a `role="img"` with a summary label. Announce totals ("12 of 30 answered") in a polite `role="status"` at coarse intervals, not for every vote (4.1.3 and 2.2.2 above).

## 8. Testing approach

- Playwright: "The viewport is included in the device but you can override it"; example `viewport: { width: 2560, height: 1440 }, deviceScaleFactor: 2`; a registry of device parameters covers user agent, screen size, viewport and touch [11][primary]. `deviceScaleFactor` is documented as "device scale factor (can be thought of as dpr). Defaults to 1" [12][primary]. Contexts also accept `reducedMotion: 'reduce'`, `forcedColors: 'active'`, `contrast: 'more'` and `colorScheme` [12][primary].
- Device descriptors in `playwright-core` 1.63.0 [12][primary]: iPhone SE 320x568 dsf 2 (WebKit); iPhone 12/13/14 viewport 390x664 with screen 390x844 dsf 3; iPad Mini 768x1024 dsf 2; Desktop Chrome 1280x720 dsf 1.

```ts
// playwright.config.ts (projects)
{ name: 'phone-320',   use: { ...devices['iPhone SE'] } },                                   // 320x568 @2
{ name: 'phone-390',   use: { ...devices['iPhone 14'], viewport: { width: 390, height: 844 } } },
{ name: 'tablet-768',  use: { ...devices['iPad Mini'] } },                                    // 768x1024 @2
{ name: 'laptop-1366', use: { ...devices['Desktop Chrome'], viewport: { width: 1366, height: 768 } } },
{ name: 'hd-1920',     use: { ...devices['Desktop Chrome'], viewport: { width: 1920, height: 1080 } } },
{ name: 'uhd-3840',    use: { ...devices['Desktop Chrome'], viewport: { width: 3840, height: 2160 } } },
```

- axe: `@axe-core/playwright` `npm view` reports latest 4.13.0 (modified 2026-09-02), MPL-2.0, peer `playwright-core >= 1.0.0`; `axe-core` 4.13.0; `playwright` 1.63.0 [13][primary]. Its version follows axe-core's major.minor. Playwright's docs use `new AxeBuilder({ page }).withTags(['wcag2a','wcag2aa','wcag21a','wcag21aa']).analyze()` and warn that automation cannot find all problems [11][primary]. Add `wcag22aa`: axe's `target-size` rule carries `wcag22aa, wcag258`, and `meta-viewport` carries `wcag144` [13][primary].
- **Inference (checks per viewport):** (1) `document.documentElement.scrollWidth <= window.innerWidth` on player, host and editor views; (2) axe on every state (lobby, question, locked, reveal, leaderboard, podium, editor); (3) presenter screenshots at 1366x768, 1920x1080 and 3840x2160 compared after downscaling to prove identical composition; (4) re-run with `reducedMotion: 'reduce'`, `contrast: 'more'`, `colorScheme: 'dark'`; (5) manual: DevTools vision emulation, 200% zoom, 320 px reflow, keyboard-only, TalkBack and VoiceOver. axe cannot judge projector ambient light, thumb reach or shape distinguishability.

## Design rules for zqhoot (Inference)

**Presenter type scale** (u = 1% of stage height via `cqh`; px at 768 / 1080 / 2160):

| Role | Size | Weight | px at 768 / 1080 / 2160 |
|---|---|---|---|
| Countdown numeral (tabular) | 18u | 800 | 138 / 194 / 389 |
| Join code / PIN | 10u | 800 | 77 / 108 / 216 |
| Question (auto-fit 5u to 8u) | 7u | 700 | 54 / 76 / 151 |
| Podium names | 6.5u | 700 | 50 / 70 / 140 |
| Answer text (floor 4.3u) | 5u | 600 | 38 / 54 / 108 |
| Leaderboard name and score | 5u | 700 | 38 / 54 / 108 |
| Chart labels and counts | 4.5u | 600 | 35 / 49 / 97 |
| Minimum for essential text | 4.3u | 600 | 33 / 46 / 93 |
| Non-essential meta only ("Question 3 of 10") | 3.5u | 600 | 27 / 38 / 76 |

Room-size preset multiplies everything: small 0.85, medium 1.0, large 1.15 (from 0.714 x distance/height, section 1.1). Line-height 1.2 for display text, 1.35 for answers. Content padding 5cqh vertical, 5cqw horizontal. Text-size control 100/125/150%. Light stage default, dark stage toggle. Request a wake lock on the presenter view over HTTPS.

**Phone type scale and targets** (rem; base 16 px; no vw font sizing except inside `clamp` with a rem term):

| Role | Size |
|---|---|
| Question | `clamp(1.25rem, 1.05rem + 1vw, 1.75rem)` (20 px at 320, 24.5 at 768) |
| Answer text | 1.125rem (18 px), weight 600 |
| Letter in badge | 1.5rem (24 px), weight 800 |
| Countdown numeral | 2rem (32 px), tabular |
| Inputs | at least 1rem (16 px) |
| Status and helper text | 0.875rem (14 px) minimum, never for essential content |

Gutter 16 px, safe areas via `max(16px, env(safe-area-inset-*))`. Interactive minimum 48x48 px; answer rows at least 72 px tall (4.5rem), 12 px gaps. Stacked answers below about 420 px container width; 2x2 above only for short or image answers. Page shell `min-height: 100vh; min-height: 100svh`. No `maximum-scale`; `touch-action: manipulation` on buttons.

**Colour tokens** (ratios computed):

| Token | Light stage | Dark stage |
|---|---|---|
| `--bg` | #FFFFFF | #0B1020 |
| `--surface` | #F1F4F9 (ink on it 17.17:1) | #141B30 (ink on it 15.80:1) |
| `--ink` | #0B1020 (18.93:1 on bg) | #F4F6FB (17.51:1 on bg) |
| `--ink-2` | #3A4258 (10.00:1) | #C3CAD9 (11.51:1) |
| Outline and focus ring | `--ink`, 4 px, offset 3 px | `--ink`, 4 px, offset 3 px |
| `--ans-a` blue | #0072B2 | #0072B2 |
| `--ans-b` vermillion | #D55E00 | #D55E00 |
| `--ans-c` yellow | #F0E442 | #F0E442 |
| `--ans-d` bluish green | #009E73 | #009E73 |

Surface against background is only 1.10:1 (light) and 1.11:1 (dark), so cards need the ink outline. Fills are used only inside outlined glyphs and bars. No text lighter than #3A4258 on the light stage. Correct/incorrect: icon plus text, never colour alone. Timer: numeral plus shrinking outline, no flashing; nothing pulses red.

**Shapes:** A hexagon, B plus, C five-point star, D dome, each with letter A-D at 1.5x the answer text size, glyph box at least 32 px on phones and 8u on the stage.

## Not verified / open questions

- **Hoober's thumb-zone studies** (UXmatters 2013 and later): not reachable; only recalled from memory. Searched: none before budget end; W3C cites Parhi et al. 2006 (not read).
- **iOS Safari zooms inputs below 16 px:** background knowledge only; test on a real device.
- **Dark-on-light versus light-on-dark on projectors, saturated red/blue rendering, and safe-margin conventions:** no sources found; the ambient model in 1.3 is my illustration, and ambient fractions of 5-30% are assumed.
- **DISCAS specifics:** the standard PDF was not read. Unresolved: how "element height" maps to font size, and recommended minimum %EH values. The formula and acuity factors came from search summaries of AVIXA pages. ANSI/INFOCOMM 3M contrast classes not read. The University of Houston AV standard and Epson/BGR pages appeared in results but I extracted no text-size rule from them.
- **CVD prevalence:** only "roughly 1 in 20" (secondary). No primary figure.
- **Okabe-Ito and Tol originals** (jfly.iam.u-tokyo.ac.jp, SRON note) not fetched; hex values come from R's source and Tol's own package.
- **Apple HIG and Material pages:** not read; 44 pt and 48 dp are from Flutter constants that cite them.
- **WCAG 2.2 Recommendation on www.w3.org** not fetched; text is from `w3c/wcag` main. Search-summary quotes of the rendered pages matched where I compared.
- **Legal reading of 2.2.1 for live quizzes:** no authority found.
- **Open design questions:** should phones show answer text or only shapes (this doc assumes text plus shape)? Are per-player time multipliers acceptable to hosts? Do real projectors confirm the ambient model? Does Playwright's WebKit reproduce iOS Safari toolbar behaviour for `svh`/`dvh` (unverified; needs a real device)? Whether CSS typed arithmetic is baseline (would allow a pure-CSS transform scale) was not checked.

## Sources

1. WCAG success criteria source text, W3C `w3c/wcag` repo, main branch (Recommendation source, not rendered page). Base `https://raw.githubusercontent.com/w3c/wcag/main/guidelines/sc/` then: `20/non-text-content.html`, `20/info-and-relationships.html`, `21/orientation.html`, `20/use-of-color.html`, `20/contrast-minimum.html`, `20/contrast-enhanced.html`, `20/resize-text.html`, `21/reflow.html`, `21/non-text-contrast.html`, `21/text-spacing.html`, `21/content-on-hover-or-focus.html`, `20/keyboard.html`, `20/timing-adjustable.html`, `20/pause-stop-hide.html`, `20/three-flashes-or-below-threshold.html`, `20/focus-order.html`, `20/focus-visible.html`, `22/focus-not-obscured-minimum.html`, `21/label-in-name.html`, `22/dragging-movements.html`, `22/target-size-minimum.html`, `21/target-size-enhanced.html`, `20/on-focus.html`, `20/on-input.html`, `20/consistent-navigation.html`, `20/consistent-identification.html`, `22/consistent-help.html`, `20/error-identification.html`, `20/labels-or-instructions.html`, `22/redundant-entry.html`, `22/accessible-authentication-minimum.html`, `20/name-role-value.html`, `21/status-messages.html`, `20/parsing.html`. Rendered spec (not fetched): https://www.w3.org/TR/WCAG22/
2. WCAG term definitions: `https://raw.githubusercontent.com/w3c/wcag/main/guidelines/terms/20/` then `contrast-ratio.html`, `essential.html`, `flash.html`, `general-flash-and-red-flash-thresholds.html`, `large-scale.html`, `real-time-event.html`, `relative-luminance.html`
3. WCAG Understanding docs: `https://raw.githubusercontent.com/w3c/wcag/main/understanding/` then `20/timing-adjustable.html`, `20/pause-stop-hide.html`, `22/target-size-minimum.html`, `21/target-size-enhanced.html`, `21/non-text-contrast.html`, `21/status-messages.html`, `22/accessible-authentication-minimum.html`, `20/use-of-color.html`, `20/contrast-minimum.html`. Resources it links (not fetched): https://developer.apple.com/design/human-interface-guidelines/pointing-devices ; https://m2.material.io/design/layout/spacing-methods.html ; https://www.cs.umd.edu/hcil/trs/2006-11/2006-11.htm
4. WCAG techniques: `https://raw.githubusercontent.com/w3c/wcag/main/techniques/failures/F94.html` (viewport units and 1.4.4), `.../techniques/failures/F110.html` (sticky bars and 2.4.11), `.../techniques/css/C43.html` (scroll-padding)
5. MDN content (`https://raw.githubusercontent.com/mdn/content/main/files/en-us/web/`): `css/reference/values/length/index.md`, `css/reference/values/clamp/index.md`, `css/reference/values/env/index.md`, `css/guides/containment/container_queries/index.md`, `css/reference/properties/touch-action/index.md`, `html/reference/elements/meta/name/viewport/index.md`, `api/navigator/vibrate/index.md`, `api/screen_wake_lock_api/index.md`, `css/reference/at-rules/@media/prefers-reduced-motion/index.md`, `css/reference/at-rules/@media/prefers-contrast/index.md`, `accessibility/guides/colors_and_luminance/index.md`
6. `@mdn/browser-compat-data` 8.1.3, https://registry.npmjs.org/@mdn/browser-compat-data (queried locally, `data.json`)
7. `caniuse-db` 1.0.30001813, https://registry.npmjs.org/caniuse-db (features `viewport-unit-variants`, `css-container-queries`, `css-container-query-units`, `css-env-function`, `css-touch-action`, `vibration`, `wake-lock`, `prefers-reduced-motion`; dataset updated 2026-09-28)
8. web.dev, "The large, small, and dynamic viewport units" (2022-11-29), source https://raw.githubusercontent.com/GoogleChrome/web.dev/main/src/site/content/en/blog/viewport-units/index.md ; page https://web.dev/blog/viewport-units
9. Chrome DevTools, "Apply other effects" (emulate vision deficiencies), https://raw.githubusercontent.com/GoogleChrome/developer.chrome.com/main/site/en/docs/devtools/rendering/apply-effects/index.md
10. Chrome blog, "Simulating color vision deficiencies", https://raw.githubusercontent.com/GoogleChrome/developer.chrome.com/main/site/en/blog/cvd/index.md
11. Playwright docs: `https://raw.githubusercontent.com/microsoft/playwright/main/docs/src/emulation.md`, `.../docs/src/test-use-options-js.md`, `.../docs/src/accessibility-testing-js.md`
12. `playwright-core` 1.63.0, https://registry.npmjs.org/playwright-core (`types/types.d.ts` doc comments; `devices` registry loaded locally)
13. `@axe-core/playwright` 4.13.0 (README and `npm view`), https://registry.npmjs.org/@axe-core/playwright ; axe-core rule list https://raw.githubusercontent.com/dequelabs/axe-core/develop/doc/rule-descriptions.md
14. Okabe-Ito hex values: R source https://raw.githubusercontent.com/wch/r-source/trunk/src/library/grDevices/R/colorstuff.R ; https://raw.githubusercontent.com/clauswilke/colorblindr/master/R/palettes.R (cites the Okabe and Ito article; not fetched: https://web.archive.org/web/20210108233739/http://jfly.iam.u-tokyo.ac.jp/color/)
15. `tol_colors` 2.2.0 (Paul Tol and Clement Haeck), https://pypi.org/project/tol-colors/ ; sdist https://files.pythonhosted.org/packages/2a/18/c4877a3dfd90a7350da789fb3e23f2a0a711eb13d56f3c9f6ce1aa9876b9/tol_colors-2.2.0.tar.gz (`colors.json`, `docs/source/colorsets.rst`)
16. Flutter framework constants: https://raw.githubusercontent.com/flutter/flutter/master/packages/flutter/lib/src/material/constants.dart ; https://raw.githubusercontent.com/flutter/flutter/master/packages/flutter/lib/src/cupertino/constants.dart
17. AVIXA DISCAS pages (seen via WebSearch summaries only): https://www.avixa.org/standards/discas-calculators/discas/learn-more-about-display-size ; https://www.avixa.org/resources/display-image-size-calculators/analytical-and-basic-decision-making-calculations ; https://www.avixa.org/standards/display-image-size-for-2d-content-in-audiovisual-system ; https://webstore.ansi.org/preview-pages/InfoComm/preview_ANSI+INFOCOMM+V202.01-2016.pdf
18. (unused number kept free)
19. 4-6-8 rule explanations (search summaries only): https://www.slashgear.com/2221483/what-is-4-6-8-rule-for-projectors/ ; https://www.bgr.com/2222593/what-is-the-4-6-8-rule-projectors-explained/
20. AV-INFO, "Projection Rules" (search summary only): https://av-info.eu/video/projectionrules.html
21. Strong MDI, DISCAS blog (search summary only): https://strongmdi.com/blog/when-bigger-is-better-display-image-size-for-2d-content-in-audiovisual-systems-discas-the-new-infocomm-standard/
22. Visual Displays Ltd, DISCAS resources (search summary only): https://visualdisplaysltd.com/resources/industry-standards/discas
23. Wikipedia, "X-height" (search summary only): https://en.wikipedia.org/wiki/X-height
24. W3C WAI, "Complex Images" tutorial (search summary only): https://www.w3.org/WAI/tutorials/images/complex/
