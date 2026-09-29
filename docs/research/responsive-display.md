# Responsive display: projector, phone and host views (research for zqhoot)

Accessed: 2026-09-29. Purpose: evidence and numbers for one React app serving a projector presenter view (16:9, 10+ m away), a phone player view (320 px minimum, one hand) and laptop host/editor views. Nothing here copies Kahoot or Mentimeter styling.

## How this evidence was gathered (read first)

- WebFetch returned EGRESS_BLOCKED for developer.mozilla.org, web.dev, caniuse.com, playwright.dev, www.avixa.org, risertools.com and visualdisplaysltd.com (one attempt each). The WebSearch budget (200 calls, session-wide) ran out partway, so parts of sections 1 and 3 are "Not verified".
- Afterwards I read primary documents from public GitHub raw files and package registries the proxy allowed: `w3c/wcag` (spec source, Understanding docs, techniques), `mdn/content`, Chrome and web.dev doc sources, `microsoft/playwright` docs, npm and PyPI packages. WCAG text below is the spec source in W3C's own repo, not the rendered www.w3.org page. Browser support comes from `@mdn/browser-compat-data` 8.1.3 [6] and `caniuse-db` 1.0.30001813 (updated 2026-09-28) [7], queried locally.
- Tags: **[primary]** = W3C, MDN, vendor docs, standards body, package data. **[primary via search summary]** = standards-body page seen only through WebSearch summaries. **[secondary]** = third party. **Inference:** = my reasoning or proposal. **Unverified (background knowledge)** = from memory. All contrast and colour-difference numbers are my computations (WCAG formula [2]; CIEDE2000 via `culori` 4.0.2), scripts kept outside the repo.

## Key findings

1. AVIXA's DISCAS uses acuity factor 200 for basic decision making, i.e. farthest viewer = image height x element height (fraction) x 200 [17][primary via search summary]; that reproduces the 4-6-8 rule at 2%, 3%, 4% element height (my arithmetic).
2. **Inference:** a 2.5-3.0 m wide screen seen from 10 m is 6-7 screen heights away, so essential text should be about 4.3-5.0% of stage height (46-54 px at 1080p). How DISCAS defines "element height" is unresolved (3.0-6.0% at 6 heights).
3. **Inference (model):** a lit room adding luminance `a` caps contrast at (1+a)/a: 6:1 at a = 0.2, and a 4.5:1 pair falls to 3.2:1. Essential projector text needs at least 15:1 nominal, secondary at least 10:1.
4. **Inference:** presenter = 16:9 size container with everything in `cqh` (1% of stage height): identical composition at 1366x768, 1920x1080, 3840x2160 (1u = 7.68 / 10.8 / 21.6 px). Container units: Safari 16, Chrome 105, Firefox 110 [6][7][primary].
5. WCAG technique F94: text sized mainly in viewport units is likely to fail 1.4.4; media-query steps and on-page size controls are acceptable [4][primary]. **Inference:** stage units in the presenter view plus a text-size control; rem on phones and host views.
6. Phone platform facts [5][6][7][primary]: `dvh`/`svh` iOS Safari 15.4; `env(safe-area-inset-*)` 11.3; `touch-action: manipulation` full from iOS 13; Wake Lock 16.4 but broken in Home Screen web apps until 18.4, HTTPS only; `navigator.vibrate` not supported in iOS Safari.
7. **Inference (computed):** at 320 px a 2x2 grid gives 138 px tiles (about 13 characters per line at 18 px), a stacked list about 24. Stack by default.
8. Tap targets: WCAG 2.2 AA 24x24 CSS px or spacing, AAA 44x44 [1][primary]; Apple 44 pt and Material 48 dp via Flutter's constants [16][secondary]. **Inference:** 48 px minimum, 72 px answer rows.
9. **Inference:** a live shared countdown plausibly fits WCAG 2.2.1's "real-time event" exception, but do not rely on it; offer untimed questions and host-set per-player time multipliers, which W3C's Understanding text endorses ("a third party can control the time limits") [3][primary].
10. New in WCAG 2.2 and relevant: 2.4.11, 2.5.7, 2.5.8, 3.3.7, 3.3.8. 4.1.1 Parsing is obsolete and removed [1][primary].
11. **Inference (computed):** blue/vermillion/yellow/bluish green from Okabe-Ito keep CIEDE2000 differences of at least 10.7 under simulated CVD, but vermillion and green differ by only 1.13:1 in luminance, so shape, letter and position carry identity.
12. **Inference:** shapes A hexagon, B plus, C star, D dome plus letters A-D; none is Kahoot's triangle, diamond, circle or square. Answer text is ink on a neutral card; colour fills only outlined glyphs and bars.
13. Testing [11][12][13][primary]: six Playwright projects plus `@axe-core/playwright` 4.13.0 with `wcag22aa`. Playwright's iPhone 12/13/14 descriptors are 390x664, so set 390x844 explicitly.
14. Not verified: Hoober's studies, iOS input zoom below 16 px, projector polarity, saturated red/blue on projectors, safe margins, ANSI/INFOCOMM 3M classes, CVD prevalence beyond "1 in 20", direct Apple and Material pages.

## 1. Projector legibility

### 1.1 Text size versus distance

- DISCAS (ANSI/INFOCOMM V202.01:2016) sets image size for basic and analytical decision making, derived from ANSI/INFOCOMM 3M-2011 [17][primary via search summary]. AVIXA calculator pages give acuity factors 200 (basic) and 3438 (analytical) and define an "element" as a group of pixels conveying an item of information [17][primary via search summary]. Analytical: farthest viewer = image height x 3438 / vertical resolution [17][primary via search summary]; irrelevant for quiz text.
- The 4-6-8 rule: farthest viewer at most 4, 6 or 8 image heights for analytical, general presentation and passive viewing [18][secondary]. **Inference (arithmetic on the factor 200):** these are 2%, 3%, 4% element height.
- Rule of thumb: character height at least 1/200 of viewing distance (quoted as 20 arcminutes, from the FAA); readability minimums of 5 and 7 arcminutes are also quoted [19][secondary]. That page's own example (10 m gives 40 mm) contradicts 1/200 (50 mm), so treat its numbers cautiously.
- "Element height" is ambiguous. Search summaries of DISCAS explainers say a lowercase "e" at 11 pt on 1080 lines is 6 px (0.5% element height) and that DISCAS with 1080 lines and 20 pt type gives a factor of 5, which fits element height being about the font size [20][secondary]; which page said what is not identified. Typical proportions: cap height about 70%, x-height about 48% of the em [21][secondary].

**Inference: conversion** (u = 1% of stage height; computed):

| Distance / image height | Element height | Font size if element = em | if cap height (0.70 em) | if x-height (0.5 em) |
|---|---|---|---|---|
| 4 | 2.0% | 2.0u | 2.9u | 4.0u |
| 6 | 3.0% | 3.0u | 4.3u | 6.0u |
| 7 | 3.5% | 3.5u | 5.0u | 7.0u |
| 8 | 4.0% | 4.0u | 5.7u | 8.0u |

A 2.5 m wide image is 1.41 m tall, so 10 m is 7.1 heights; 3.0 m wide is 5.9; 4.0 m wide is 4.4. I adopt the cap-height reading (it matches the 1/200 rule): minimum font size is about 0.714 x (distance / image height) u.

### 1.2 Weight and family

- WCAG's definition of large-scale text: "Fonts with extraordinarily thin strokes or unusual features and characteristics that reduce the familiarity of their letter forms are harder to read, especially at lower contrast levels." [2][primary] It is the only sourced font guidance I found.
- **Inference:** one sans family with large x-height and open counters; body weight 500-600, headings 700-800, never below 400. `font-variant-numeric: tabular-nums` for countdowns and scores (Safari 9.1, Chrome 52, Firefox 34 [6][primary]). Specific projector-safe families: Not verified.

### 1.3 Contrast

- Contrast ratio is (L1 + 0.05) / (L2 + 0.05) [2][primary]. AA text 4.5:1 (large 3:1); AAA (1.4.6) 7:1 (large 4.5:1) [1][primary].
- **Inference (model):** ambient luminance `a` adds equally to every pixel, so effective ratio = (Lfg + a)/(Lbg + a). Computed:

| Pair (nominal ratio) | a = 0.05 | 0.10 | 0.20 | 0.30 |
|---|---|---|---|---|
| Ink #0B1020 on white (18.93) | 18.93 | 10.43 | 5.84 | 4.26 |
| Ink-2 #3A4258 on white (10.00) | 10.00 | 7.10 | 4.71 | 3.66 |
| Ink on yellow #F0E442 (14.32) | 14.32 | 8.00 | 4.59 | 3.42 |
| White on blue #0072B2 (5.19) | 5.19 | 4.36 | 3.40 | 2.87 |
| Ink on vermillion #D55E00 (4.90) | 4.90 | 3.05 | 2.05 | 1.71 |
| #767676 on white (4.54, AA minimum) | 4.54 | 3.91 | 3.15 | 2.70 |
| Ceiling (1+a)/a | 21.0 | 11.0 | 6.0 | 4.33 |

- Mid-luminance fills with text on them collapse first. Rule: essential text at least 15:1 nominal, secondary at least 10:1, nothing essential printed on mid-luminance fills. The `a` values are assumed; I found no measured ambient fractions.
- In this model the ratio is symmetric, so dark-on-light versus light-on-dark is decided by other effects (glare, adaptation). I found no source. **Not verified.** **Inference:** ship a light stage (default for lit rooms) and a dark stage (dim rooms) with a host toggle, both at 17:1+.
- ANSI/INFOCOMM 3M-2011 projected-image contrast classes exist [17][primary via search summary]; numbers not read. **Not verified.**

### 1.4 Saturated red/blue; safe margins

- No source found on projectors rendering saturated red or blue badly. **Not verified.** **Inference:** avoid #FF0000 and #0000FF fills; the proposed palette contains neither. WCAG's red flash is a pair of opposing transitions to and from a state with R/(R+G+B) >= 0.8 and a chromaticity change above 0.2 [2][primary], another reason not to pulse red across a projected wall.
- Safe margins: no source. Unverified (background knowledge): broadcast title-safe is about the inner 90%. **Inference:** keep essential content in the inner 90% on both axes.

## 2. Scaling one layout from 1366x768 to 3840x2160

### 2.1 Building blocks

- `clamp(min, preferred, max)` bounds a value [5][primary]; Safari 13.1, Chrome 79, Firefox 75 [6][primary].
- `vh`/`vw` are 1% of viewport height/width, `vmin`/`vmax` the smaller/larger. Default units currently equal the large-viewport (`lv*`) ones [5][primary]. Small (`sv*`) assumes browser UI expanded, large retracted, dynamic (`dv*`) follows it [8][primary]. Dynamic units change while scrolling and are throttled; viewport units ignore classic scrollbars and the on-screen keyboard [5][8][primary]. Support: Safari/iOS 15.4, Chrome 108, Firefox 101 [6][primary]; about 95.0% usage [7][primary].
- Container queries and units (`cqw`, `cqh`): `container-type: size` applies layout, style and size containment; units fall back to the small viewport when no container exists [5][primary]. Support: Safari 16, Chrome 105, Firefox 110 [6][primary]; about 94.8% usage (caniuse marks Chrome 105 partial for a multicolumn-table bug, full at 106) [7][primary].

### 2.2 Fixed transformed stage versus fluid (Inference)

| | Fixed 1920x1080 stage + `transform: scale()` | Fluid in stage units (`cqh`) |
|---|---|---|
| Composition at every size | Pixel-identical | Identical when 16:9 letterboxed |
| JavaScript | Needed for a unitless scale (whether dividing lengths in `calc()` is baseline: not verified) | None |
| Text | Scaled raster | Native, crisp |
| Reuse in a host preview thumbnail | Awkward | Natural: any container gives the unit |
| Text-resize criterion (1.4.4) | Scale cancels zoom | Also cancels zoom (F94); needs a control |

**Inference:** fluid `cqh` for the presenter, a `min(1vh, 0.5625vw)` fallback for pre-2022 browsers, no scaling on phones.

### 2.3 Same composition at 4K, not tiny text

```css
.stage-frame { display: grid; place-items: center; min-height: 100vh; background: var(--letterbox); }
.stage       { container-type: size; aspect-ratio: 16 / 9; width: min(100vw, calc(100vh * 16 / 9)); }
.stage__body { --u: min(1vh, 0.5625vw); }                 /* fallback */
@supports (height: 1cqh) { .stage__body { --u: 1cqh; } } /* 1% of stage height */
.q { font-size: calc(var(--u) * 7); }
```

`--u` is declared on a child because (Unverified, background knowledge) a container's own container-query units resolve against an ancestor container, not itself. At 768, 1080 and 2160 px stage height 1u is 7.68, 10.8 and 21.6 px, so a 5u answer is 38, 54 and 108 px. CSS px are what count: a 4K TV at device pixel ratio 2 is 1920x1080 CSS px, which Playwright can emulate with `deviceScaleFactor` [11][primary].

- F94: viewport units applied to text "prevent most available methods" of resizing; "If media queries were used to adjust the size of text ... it may not be a failure ... On-page controls provided by the author are also a way of passing the resize text success criteria." [4][primary] **Inference:** presenter and host "Text size" control (100/125/150%) multiplying `--u`; never `user-scalable=no`.
- **Inference:** host and editor views are rem-based with step media queries, not continuous vw: root font-size 100% to 2559 CSS px, then 133% (2560), 167% (3200), 200% (3840). Avoid `100vw` widths (scrollbars are ignored) [8][primary].

## 3. Phone player view

### 3.1 Thumb zone

- W3C's Understanding docs for 2.5.8 and 2.5.5 cite "One-Handed Thumb Use on Small Touchscreen Devices" (Parhi, Karlson, Bederson 2006) as a resource; I did not read it [3][primary]. Steven Hoober's studies: **Not verified** (unreachable; search budget ended). Unverified (background knowledge): Hoober's 2013 study reported about half of touches as one-handed thumb use, lower-middle of the screen easiest, top corners hardest.
- **Inference:** question and timer at the top (read-only); answers in the lower 60% of the viewport; no critical targets in top corners.

### 3.2 2x2 versus stacked at 320 px (computed)

16 px gutters, 12 px gap, 12 px tile padding, 18 px text, assumed 0.5 em average glyph width:

| Viewport | 2x2 tile width | chars/line | Stacked row width | chars/line (44 px badge) |
|---|---|---|---|---|
| 320 | 138 | about 13 | 288 | about 24 |
| 390 | 173 | about 17 | 358 | about 31 |
| 768 | 362 | about 38 | 736 | about 73 |

Four stacked 72 px rows with 12 px gaps need 324 px. **Inference:** stack by default when phones show answer text; switch to 2x2 by container query (about 420 px) only for answers of 24 characters or fewer or images. Keep DOM order A, B, C, D in both layouts (2.4.3) [1][primary].

### 3.3 Zoom, viewport meta, double-tap

- iOS input zoom: Unverified (background knowledge) that iOS Safari zooms into focused inputs below 16 px. **Inference:** inputs at least 16 px; do not "fix" it with `maximum-scale=1`: MDN warns `user-scalable=no` "prevents people experiencing low vision conditions from being able to read", WCAG requires at least 2x scaling, and iOS 10+ ignores it by default [5][primary]; axe flags it (`meta-viewport`, `wcag144`) [13][primary].
- `<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">`: `cover` fills the display and MDN "highly recommend[s]" safe-area insets [5][primary]. `env(safe-area-inset-*)`: iOS Safari 11.3 (11.0-11.2 used `constant()`), Chrome 69 [6][7][primary].
- `touch-action: manipulation` "enable[s] panning and pinch zoom gestures, but disable[s] additional non-standard gestures such as double-tap to zoom" and removes the click delay [5][primary]; iOS 9.3 partial (auto and manipulation only), full from 13 [6][7][primary]. Pinch zoom stays, so 1.4.4 is unharmed.
- `interactive-widget=resizes-content` is Chrome for Android 108 only [6][primary]; the on-screen keyboard does not change viewport units [8][primary]. Keep the join input and button above the keyboard.

### 3.4 `100vh`, `dvh`, safe areas

- On mobile `100vh` "will bleed out of the viewport" on load [8][primary]. **Inference:** `min-height: 100vh; min-height: 100svh;` for shells; `dvh` only for full-bleed backgrounds since it changes during scroll [5][8][primary]. Pad fixed bars with `calc(1rem + env(safe-area-inset-bottom))`, as in MDN's example [5][primary].

### 3.5 Haptics and Screen Wake Lock

| API | iOS Safari | Android Chrome | Notes |
|---|---|---|---|
| `navigator.vibrate` | Not supported [6][7] | 32 [6] | Needs user activation; silent or Do Not Disturb can suppress; no effect without hardware [5]. Firefox Android 79 "partial": returns true, does not vibrate [6]. About 79% usage [7] |
| Screen Wake Lock | 16.4 in Safari; 16.4-18.3 "Does not work in standalone Home Screen Web Apps" (WebKit bug 254545), full 18.4 [6]; caniuse lists 16.4 [7] | 84 (caniuse 85) [6][7] | Secure contexts only (MDN banner); released if the document is hidden; MDN lists "presenting to an audience" as a use [5] |

**Inference:** haptics only behind `'vibrate' in navigator`, never the sole signal ("Answer locked" also gets text). Plain `http://` on a LAN loses Wake Lock on phones and the presenter laptop, so make HTTPS (or `localhost`) a deployment requirement.

## 4. Tap target sizes

- WCAG 2.2 SC 2.5.8 Target Size (Minimum), AA: "The size of the target for pointer inputs is at least 24 by 24 CSS pixels, except when:" Spacing: "Undersized targets (those less than 24 by 24 CSS pixels) are positioned so that if a 24 CSS pixel diameter circle is centered on the bounding box of each, the circles do not intersect another target or the circle for another undersized target"; plus Equivalent, Inline, User Agent Control and Essential [1][primary]. Understanding: 20x20 targets with 4 px gaps pass, with no gap fail; independent of page zoom [3][primary].
- SC 2.5.5 Target Size (Enhanced), AAA: "The size of the target for pointer inputs is at least 44 by 44 CSS pixels except when:" Equivalent, Inline, User Agent Control, Essential [1][primary]. Understanding recommends larger sizes for frequently used, hard-to-undo, hard-to-reach or sequential-task controls [3][primary]; an answer button is at least frequent, irreversible and sequential.
- Apple 44 pt and Material 48 dp: I could not read either page. Flutter's constants say `kMinInteractiveDimension = 48.0` "according to Material guidelines" and `kMinInteractiveDimensionCupertino = 44.0` "according to Apple human interface guidelines" [16][secondary]. W3C lists both as resources [3][primary]. Direct quotes: **Not verified.**
- **Inference:** 48x48 CSS px minimum for every control (meets AAA and both platforms), 72 px answer rows, 12 px gaps, never under 8 px.

## 5. WCAG 2.2 criteria that apply

Quotes are from the spec source [1][primary]; levels from the same files. Definitions [2], Understanding notes [3] and techniques [4] cited in rows are also [primary].

| SC | How it applies to zqhoot |
|---|---|
| 1.1.1 Non-text Content (A): "All non-text content that is presented to the user has a text alternative that serves the equivalent purpose" | Shape glyphs `aria-hidden`; charts get a table or summary (section 7). |
| 1.3.1 Info and Relationships (A): "Information, structure, and relationships conveyed through presentation can be programmatically determined or are available in text." | Headings, lists for answers, real `<table>` for leaderboard, labelled inputs. |
| 1.3.4 Orientation (AA): "Content does not restrict its view and operation to a single display orientation ... unless a specific display orientation is essential." Its text lists "slides for a projector or television" as essential | Presenter may be landscape-only; player, host, editor work in both. |
| 1.4.1 Use of Color (A): "Color is not used as the only visual means of conveying information, indicating an action, prompting a response, or distinguishing a visual element." | Identity = letter + shape + position + colour; correct/incorrect = icon + text. |
| 1.4.3 Contrast (Minimum) (AA): 4.5:1; "Large-scale text ... 3:1"; large-scale is "at least 18 point or 14 point bold" [2]. 14/18 pt is about 18.5/24 CSS px [3] | All text 4.5:1+; projector target far higher (1.3). |
| 1.4.4 Resize Text (AA): "text can be resized without assistive technology up to 200 percent without loss of content or functionality" | F94 caveat (2.3); never block phone zoom. |
| 1.4.10 Reflow (AA): "without requiring scrolling in two dimensions for: Vertical scrolling content at a width equivalent to 320 CSS pixels"; exempts 2-D content, listing "games, presentations" | Player, host, editor reflow at 320; presenter is a presentation but still avoid horizontal scroll. |
| 1.4.11 Non-text Contrast (AA): 3:1 against adjacent colours for "Visual information required to identify user interface components and states" and "Parts of graphics required to understand the content" | 3-4 px ink outline on cards, glyphs, bars. Values are not rounded (2.999 fails) [3]. |
| 1.4.12 Text Spacing (AA): no loss at line height 1.5, paragraph spacing 2, letter spacing 0.12, word spacing 0.16 (times font size) | No fixed-height text boxes outside the auto-fitting stage. |
| 1.4.13 Content on Hover or Focus (AA): dismissible, hoverable, persistent | Editor and host tooltips only. |
| 2.1.1 Keyboard (A): "All functionality of the content is operable through a keyboard interface" | Host controls, editor, ranking reorder, A-D and 1-4 keys. |
| 2.2.1, 2.2.2 | See 5.1, 5.2. |
| 2.3.1 Three Flashes or Below Threshold (A): "Web pages do not contain anything that flashes more than three times in any one second period, or the flash is below the general flash and red flash thresholds." | No flashing countdown, confetti or podium strobe. Area limit is 0.006 sr in any 10 degree field [2]; **Inference:** easy to exceed on a projector. |
| 2.4.3 Focus Order (A); 2.4.7 Focus Visible (AA) | DOM order = visual order; 4 px outline, 3 px offset, visible on every fill. |
| 2.4.11 Focus Not Obscured (Minimum) (AA, new): "the component is not entirely hidden due to author-created content" | Sticky timer or safe-area bars must not hide the focused answer: failure F110, technique C43 `scroll-padding` [4]; `scroll-padding-block` Safari 15, Chrome 69, Firefox 68 [6]. |
| 2.5.3 Label in Name (A): "the name contains the text that is presented visually" | Visible "A" plus answer text forms the name; no differing `aria-label`. |
| 2.5.7 Dragging Movements (AA, new): "All functionality that uses a dragging movement for operation can be achieved by a single pointer without dragging" | Ranking questions get up/down buttons or tap-to-place. |
| 3.2.1 On Focus, 3.2.2 On Input (A): changing a control does not cause a change of context "unless the user has been advised of the behavior before using the component" | Say "Tap an answer to lock it in" before the question. |
| 3.2.3, 3.2.4 (AA), 3.2.6 Consistent Help (A, new) | Same letter, shape, colour per position on every question; help link in one place. |
| 3.3.1 Error Identification (A): "the item that is in error is identified and the error is described to the user in text"; 3.3.2 Labels or Instructions (A) | PIN and nickname errors in text; visible labels. |
| 3.3.7 Redundant Entry (A, new): "auto-populated, or available for the user to select" | Remember nickname on reconnect; never re-ask PIN in one flow. |
| 3.3.8 Accessible Authentication (Minimum) (AA, new): "A cognitive function test ... is not required for any step in an authentication process unless" an alternative, mechanism, object recognition or personal content is provided | Host sign-in: allow paste and password managers, offer passkey or emailed link, no puzzle CAPTCHA. Understanding scopes it to existing accounts, so player PIN entry is not obviously covered; offer QR and link join anyway [3]. |
| 4.1.2 Name, Role, Value (A) | Native `<button>` and `<input>`; ARIA on custom ranking widgets. |
| 4.1.3 Status Messages (AA): "status messages can be programmatically determined through role or properties such that they can be presented to the user by assistive technologies without receiving focus" | "Answer received", "12 of 30 answered", "Time is up" via `role="status"`. |

**4.1.1 Parsing is obsolete and removed in WCAG 2.2** (verified): the source reads "Parsing (Obsolete and removed) ... This criterion no longer has utility and is removed." [1][primary]

### 5.1 2.2.1 Timing Adjustable and a live timed quiz

Wording [1][primary]: "For each time limit that is set by the content, at least one of the following is true:" Turn off; Adjust ("over a wide range that is at least ten times the length of the default setting"); Extend (warned and "given at least 20 seconds to extend the time limit with a simple action", "at least ten times"); **"Real-time Exception: The time limit is a required part of a real-time event (for example, an auction), and no alternative to the time limit is possible"**; **"Essential Exception: The time limit is essential and extending it would invalidate the activity"**; 20 Hour Exception.

Definitions [2][primary]: "real-time event: event that a) occurs at the same time as the viewing and b) is not completely generated by the content" (examples: webcast, online auction with people bidding, live humans in a virtual world); "essential: if removed, would fundamentally change the information or functionality of the content, and information and functionality cannot be achieved in another way that would conform". Understanding on auctions: "Since the time limit applies to all users who want to bid on a particular item, it would be unfair to extend the time limit for any one particular user." And: "In cases where timing is not an intrinsic requirement but giving users control over timed events would invalidate the outcome, a third party can control the time limits for the user (for example, granting double time on a test)." [3][primary]

**Inference (decision):**
- Live synchronous mode (host advances, everyone races one countdown against other live people) is a real-time event: it mirrors the auction rationale. Not a guaranteed pass, because "no alternative ... is possible" is arguable (a host could extend for everyone).
- So provide (1) "no time limit, host advances" per question, (2) generous defaults, (3) host-set per-player multipliers (x1.5, x2), the third-party model quoted above, and (4) in any self-paced mode, which is not a real-time event, a per-player limit that can be turned off or extended.
- No case law or regulator guidance on quizzes found. **Not verified.**

### 5.2 2.2.2 Pause, Stop, Hide

Wording [1][primary]: moving, blinking or scrolling content that starts automatically, lasts more than five seconds and is "presented in parallel with other content" needs "a mechanism for the user to pause, stop, or hide it unless the movement, blinking, or scrolling is part of an activity where it is essential"; auto-updating information needs the same "or to control the frequency of the update unless the auto-updating is part of an activity where it is essential". Understanding lists "real-time games" as moving content and "an auction timer" as content where pausing would mislead [3][primary].

**Inference:** the countdown is essential, but add mechanisms: host pause; a player option to hide timer visuals (coarse text status via `role="status"` every 10 s and at 5 s); under `prefers-reduced-motion: reduce`, a numeral updating once per second with no sweeping or scaling. Presenter answer counts update at most once per second and the host can freeze them. The leaderboard reorders once per reveal.

### 5.3 Media queries

- `prefers-reduced-motion` signals a wish to "minimize the amount of non-essential motion"; scaling or panning large objects can trigger vestibular disorders [5][primary]. Safari iOS 10.3, Chrome 74, Firefox 63 [6][primary].
- `prefers-contrast`: `more`, `less`, `no-preference`, `custom` [5][primary]; Safari iOS 14.5, Chrome 96, Firefox 101 [6][primary]. `forced-colors`: iOS Safari 16, Chrome 89, Firefox 89 [6][primary]. **Inference:** `more` switches to 7:1+ ink, thicker outlines, no tinted fills; keep outlines as real borders so shapes survive forced colours.

## 6. Colour-blind-safe answer differentiation

### 6.1 Prevalence

- Chrome's DevTools team: "Roughly 1 in 20 people suffer from a color vision deficiency", citing Colour Blind Awareness (not fetched) [10][secondary]. Unverified (background knowledge): about 8% of men and 0.5% of women, mostly red-green. No primary figure found.
- MDN: luminance contrast "enables the development of content that even those with color blindness can see" [5][primary], which is why identity cannot rest on hue alone.

### 6.2 Published palettes

Okabe-Ito (Okabe and Ito, "Color Universal Design"), hex as coded in R's `palette.colors()` [14][secondary; original page not fetched]: black #000000, orange #E69F00, sky blue #56B4E9, bluish green #009E73, yellow #F0E442, blue #0072B2, vermillion #D55E00, reddish purple #CC79A7, gray #999999. A second implementation carries the same hex values [14][secondary].

Paul Tol qualitative sets from the package he co-authors (`tol_colors` 2.2.0: "Colorsets and colormaps designed by PT"; docs cite "Colour Schemes", SRON/EPS/TN/09-002, issue 3.2, 2021) [15][primary, author-maintained package; SRON note not fetched]:
- Bright: #4477AA, #EE6677, #228833, #CCBB44, #66CCEE, #AA3377, #BBBBBB.
- Vibrant: #EE7733, #0077BB, #33BBEE, #EE3377, #CC3311, #009988, #BBBBBB.
- Muted: #CC6677, #332288, #DDCC77, #117733, #88CCEE, #882255, #44AA99, #999933, #AA4499, #DDDDDD.
- High-contrast: #004488, #BB5566, #DDAA33 (plus black and white), meant to work in monochrome.

The package docs say the sets were checked with red-blind and green-blind simulation and CIEDE2000 distances, and call Vibrant and Muted "equally colorblind-safe" as Bright [15][primary].

### 6.3 Testing tools

Chrome DevTools, Rendering tab, "Emulate vision deficiencies": blurred vision, reduced contrast, protanopia, deuteranopia, tritanopia, achromatopsia [9][primary]. Chrome's team cites the Machado, Oliveira and Fernandes model; the deuteranopia matrix shown is 0.367 0.861 -0.228 / 0.280 0.673 0.047 / -0.012 0.043 0.969 [10][primary]. Firefox's Accessibility Inspector simulates them too [5][primary].

### 6.4 Proposal: shapes, letters, colours (Inference)

| Answer | Shape (24x24 viewBox) | Fill (Okabe-Ito) |
|---|---|---|
| A | Hexagon `12,2 20.66,7 20.66,17 12,22 3.34,17 3.34,7` | Blue #0072B2 |
| B | Plus `M9 2h6v7h7v6h-7v7H9v-7H2V9h7z` | Vermillion #D55E00 |
| C | Five-point star `12,2 14.47,8.6 21.51,8.91 15.99,13.3 17.88,20.09 12,16.2 6.12,20.09 8.01,13.3 2.49,8.91 9.53,8.6` | Yellow #F0E442 |
| D | Dome, flat side down `M2 18a10 10 0 0 1 20 0z` | Bluish green #009E73 |

Position adds a third cue: A B over C D (or A to D top to bottom).

Computed contrast: ink #0B1020 on white 18.93:1. Fills vs white: A 5.19, B 3.87, C 1.32, D 3.42; vs #0B1020: A 3.65, B 4.90, C 14.32, D 5.53. Yellow fails 3:1 on white alone, hence the 3-4 px ink outline on every glyph and bar (ink vs white 18.93:1).

CIEDE2000 between fills (LMS dichromat matrices from `@bjornlu/colorblind` 1.0.3 in linear RGB; Chrome's deuteranopia matrix gives a minimum pair of 20.5):

| Vision | AB | AC | AD | BC | BD | CD |
|---|---|---|---|---|---|---|
| Normal | 49.6 | 70.4 | 38.4 | 43.7 | 54.4 | 38.0 |
| Protan | 57.7 | 70.7 | 42.0 | 30.0 | 17.4 | 29.1 |
| Deutan | 64.2 | 75.4 | 36.3 | 22.4 | 22.0 | 35.5 |
| Tritan | 52.3 | 50.6 | 10.7 | 31.6 | 52.8 | 44.7 |

Achromatopsia: luminance ratios B/D 1.13:1, A/B 1.34:1, A/D 1.52:1, so these pairs are effectively identical without shape. Ranked by worst-case CIEDE2000 over all 4-of-7 Okabe-Ito subsets, this set (10.7) trails a set with two blues (20.9) and sets with two warm hues (11.1); I chose it for four clearly different hue names (blue, orange-red, yellow, green). No accepted pass mark exists (Unverified: about 10 is "clearly different"); validate with DevTools and real users.

## 7. Charts on a projector

- Sourced: text alternative needed (1.1.1), 3:1 for graphical parts (1.4.11), colour not the only cue (1.4.1) [1][primary]. WAI guidance summarised in search results: a bar-chart alternative pairs a short label with a longer description of data and trends [22][primary via search summary]. Status text like "18 results returned" is a status message, and a persistent "0 items" to "3 items" change counts as a new one [3][primary].
- **Inference (unsourced):** direct-label bars ("A hexagon, Paris, 14, 47%") instead of a legend. Show count and percentage: counts for comparison, percentages across group sizes. Labels at least 4.5u, totals 6u. Horizontal bars ordered by answer letter (stable), 5-6u thick with ink outline, zero baseline, no gradients, gridlines or 3D. Mark the correct answer with "Correct" text and a check plus outline weight, not colour.
- Alternative: a hidden `<table>` (Answer, Count, Percent) or `role="img"` with a summary. Announce totals in a polite `role="status"` at coarse intervals, not per vote.

## 8. Testing approach

- Playwright: "The viewport is included in the device but you can override it"; example `viewport: { width: 2560, height: 1440 }, deviceScaleFactor: 2`; a registry of device parameters covers user agent, screen size, viewport and touch [11][primary]. `deviceScaleFactor`: "device scale factor (can be thought of as dpr). Defaults to 1" [12][primary]. Contexts also take `reducedMotion: 'reduce'`, `forcedColors: 'active'`, `contrast: 'more'`, `colorScheme` [12][primary].
- Descriptors in `playwright-core` 1.63.0 [12][primary]: iPhone SE 320x568 dsf 2 (WebKit); iPhone 12/13/14 viewport 390x664, screen 390x844, dsf 3; iPad Mini 768x1024 dsf 2; Desktop Chrome 1280x720 dsf 1.

```ts
{ name: 'phone-320',   use: { ...devices['iPhone SE'] } },                                   // 320x568 @2
{ name: 'phone-390',   use: { ...devices['iPhone 14'], viewport: { width: 390, height: 844 } } },
{ name: 'tablet-768',  use: { ...devices['iPad Mini'] } },                                    // 768x1024 @2
{ name: 'laptop-1366', use: { ...devices['Desktop Chrome'], viewport: { width: 1366, height: 768 } } },
{ name: 'hd-1920',     use: { ...devices['Desktop Chrome'], viewport: { width: 1920, height: 1080 } } },
{ name: 'uhd-3840',    use: { ...devices['Desktop Chrome'], viewport: { width: 3840, height: 2160 } } },
```

- axe: `npm view @axe-core/playwright` reports latest 4.13.0 (modified 2026-09-02), MPL-2.0, peer `playwright-core >= 1.0.0`; `axe-core` 4.13.0; `playwright` 1.63.0 [13][primary]. Its version tracks axe-core's major.minor. Playwright's docs use `new AxeBuilder({ page }).withTags(['wcag2a','wcag2aa','wcag21a','wcag21aa']).analyze()` and warn automation cannot find every problem [11][primary]. Add `wcag22aa`: `target-size` carries `wcag22aa, wcag258`; `meta-viewport` carries `wcag144` [13][primary].
- **Inference (checks per viewport):** (1) `document.documentElement.scrollWidth <= window.innerWidth` on player, host, editor; (2) axe on every state (lobby, question, locked, reveal, leaderboard, podium, editor); (3) presenter screenshots at 1366x768, 1920x1080, 3840x2160 compared after downscaling; (4) rerun with `reducedMotion: 'reduce'`, `contrast: 'more'`, `colorScheme: 'dark'`; (5) manual: DevTools vision emulation, 200% zoom, 320 px reflow, keyboard-only, VoiceOver and TalkBack. axe cannot judge projector ambient light, thumb reach or shape distinguishability.

## Design rules for zqhoot (Inference)

**Presenter type scale** (u = 1% of stage height via `cqh`):

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
| Non-essential meta only | 3.5u | 600 | 27 / 38 / 76 |

Room preset multiplies all sizes: small 0.85, medium 1.0, large 1.15 (roughly distance/height of 6, 7, 8 in 0.714 x distance/height). Line-height 1.2 display, 1.35 answers. Padding 5cqh and 5cqw. Text-size control 100/125/150%. Light stage default, dark stage toggle. Wake lock over HTTPS.

**Phone scale and targets** (rem, base 16 px; no bare vw font sizes):

| Role | Size |
|---|---|
| Question | `clamp(1.25rem, 1.05rem + 1vw, 1.75rem)` (20 px at 320, 24.5 at 768) |
| Answer text | 1.125rem (18 px), 600 |
| Letter in badge | 1.5rem (24 px), 800 |
| Countdown numeral | 2rem (32 px), tabular |
| Inputs | at least 1rem (16 px) |
| Status and helper text | 0.875rem minimum, never essential content |

Gutter 16 px with `max(16px, env(safe-area-inset-*))`. Controls at least 48x48 px; answer rows at least 72 px, 12 px gaps. Stack below about 420 px container width. Shell `min-height: 100vh; min-height: 100svh`. No `maximum-scale`; `touch-action: manipulation` on buttons.

**Colour tokens** (ratios computed):

| Token | Light stage | Dark stage |
|---|---|---|
| `--bg` | #FFFFFF | #0B1020 |
| `--surface` | #F1F4F9 (ink on it 17.17:1) | #141B30 (ink on it 15.80:1) |
| `--ink` | #0B1020 (18.93:1 on bg) | #F4F6FB (17.51:1 on bg) |
| `--ink-2` | #3A4258 (10.00:1) | #C3CAD9 (11.51:1) |
| Outline and focus ring | `--ink`, 4 px, offset 3 px | same |
| `--ans-a` / `-b` / `-c` / `-d` | #0072B2 / #D55E00 / #F0E442 / #009E73 | same |

Surface vs background is only 1.10:1 (light) and 1.11:1 (dark), so cards need the ink outline. Fills appear only inside outlined glyphs and bars. No text lighter than #3A4258 on the light stage. Correct/incorrect: icon plus text. Timer: numeral plus shrinking outline; no flashing, nothing pulses red.

**Shapes:** A hexagon, B plus, C five-point star, D dome, each beside letters A-D at 1.5x answer text size; glyph box at least 32 px on phones, 8u on the stage.

## Not verified / open questions

- **Hoober's thumb-zone studies:** unreachable; recalled from memory only. W3C cites Parhi et al. 2006 (not read).
- **iOS Safari zooming inputs below 16 px:** background knowledge only; test on a real device.
- **Projector polarity, saturated red/blue rendering, safe margins:** no sources; the ambient model in 1.3 is my illustration with assumed values.
- **DISCAS:** standard PDF not read. Unresolved: mapping of "element height" to font size, and recommended %EH ranges. Formula and factors are from search summaries (the BDM formula's page not identified). ANSI/INFOCOMM 3M contrast classes unread. The University of Houston AV standard appeared in results but I extracted no text-size rule.
- **CVD prevalence:** only "roughly 1 in 20" (secondary).
- **Okabe-Ito and Tol originals** (jfly.iam.u-tokyo.ac.jp, SRON note) not fetched; hex values come from R's source and Tol's own package.
- **Apple HIG and Material pages** not read; 44 pt and 48 dp come from Flutter constants citing them.
- **WCAG 2.2 Recommendation on www.w3.org** not fetched; text is from `w3c/wcag` main, matching search-summary quotes wherever I compared.
- **Legal reading of 2.2.1 for live quizzes:** no authority found.
- **Open design questions:** phones show answer text or shapes only (this doc assumes text plus shape)? Are per-player multipliers acceptable to hosts? Do real projectors match the ambient model? Does Playwright WebKit reproduce iOS toolbar behaviour for `svh`/`dvh` (needs a real device)? Is CSS typed arithmetic baseline (would allow a pure-CSS transform scale)?

## Sources

1. WCAG success criteria source text, W3C `w3c/wcag` repo, main branch. Base `https://raw.githubusercontent.com/w3c/wcag/main/guidelines/sc/` then: `20/non-text-content.html`, `20/info-and-relationships.html`, `21/orientation.html`, `20/use-of-color.html`, `20/contrast-minimum.html`, `20/contrast-enhanced.html`, `20/resize-text.html`, `21/reflow.html`, `21/non-text-contrast.html`, `21/text-spacing.html`, `21/content-on-hover-or-focus.html`, `20/keyboard.html`, `20/timing-adjustable.html`, `20/pause-stop-hide.html`, `20/three-flashes-or-below-threshold.html`, `20/focus-order.html`, `20/focus-visible.html`, `22/focus-not-obscured-minimum.html`, `21/label-in-name.html`, `22/dragging-movements.html`, `22/target-size-minimum.html`, `21/target-size-enhanced.html`, `20/on-focus.html`, `20/on-input.html`, `20/consistent-navigation.html`, `20/consistent-identification.html`, `22/consistent-help.html`, `20/error-identification.html`, `20/labels-or-instructions.html`, `22/redundant-entry.html`, `22/accessible-authentication-minimum.html`, `20/name-role-value.html`, `21/status-messages.html`, `20/parsing.html`. Rendered spec (not fetched): https://www.w3.org/TR/WCAG22/
2. WCAG term definitions: `https://raw.githubusercontent.com/w3c/wcag/main/guidelines/terms/20/` then `contrast-ratio.html`, `essential.html`, `flash.html`, `general-flash-and-red-flash-thresholds.html`, `large-scale.html`, `real-time-event.html`, `relative-luminance.html`
3. WCAG Understanding docs: `https://raw.githubusercontent.com/w3c/wcag/main/understanding/` then `20/timing-adjustable.html`, `20/pause-stop-hide.html`, `22/target-size-minimum.html`, `21/target-size-enhanced.html`, `21/non-text-contrast.html`, `21/status-messages.html`, `22/accessible-authentication-minimum.html`, `20/use-of-color.html`, `20/contrast-minimum.html`. Resources it links (not fetched): https://developer.apple.com/design/human-interface-guidelines/pointing-devices ; https://m2.material.io/design/layout/spacing-methods.html ; https://www.cs.umd.edu/hcil/trs/2006-11/2006-11.htm
4. WCAG techniques: `https://raw.githubusercontent.com/w3c/wcag/main/techniques/failures/F94.html` (viewport units and 1.4.4), `.../techniques/failures/F110.html` (sticky bars and 2.4.11), `.../techniques/css/C43.html` (scroll-padding)
5. MDN content, base `https://raw.githubusercontent.com/mdn/content/main/files/en-us/web/` then `css/reference/values/length/index.md`, `css/reference/values/clamp/index.md`, `css/reference/values/env/index.md`, `css/guides/containment/container_queries/index.md`, `css/reference/properties/touch-action/index.md`, `html/reference/elements/meta/name/viewport/index.md`, `api/navigator/vibrate/index.md`, `api/screen_wake_lock_api/index.md`, `css/reference/at-rules/@media/prefers-reduced-motion/index.md`, `css/reference/at-rules/@media/prefers-contrast/index.md`, `accessibility/guides/colors_and_luminance/index.md`
6. `@mdn/browser-compat-data` 8.1.3, https://registry.npmjs.org/@mdn/browser-compat-data (queried locally)
7. `caniuse-db` 1.0.30001813, https://registry.npmjs.org/caniuse-db (features `viewport-unit-variants`, `css-container-queries`, `css-container-query-units`, `css-env-function`, `css-touch-action`, `vibration`, `wake-lock`, `prefers-reduced-motion`; dataset updated 2026-09-28)
8. web.dev, "The large, small, and dynamic viewport units" (2022-11-29): https://raw.githubusercontent.com/GoogleChrome/web.dev/main/src/site/content/en/blog/viewport-units/index.md ; page https://web.dev/blog/viewport-units
9. Chrome DevTools, "Apply other effects": https://raw.githubusercontent.com/GoogleChrome/developer.chrome.com/main/site/en/docs/devtools/rendering/apply-effects/index.md
10. Chrome blog, "Simulating color vision deficiencies": https://raw.githubusercontent.com/GoogleChrome/developer.chrome.com/main/site/en/blog/cvd/index.md
11. Playwright docs: https://raw.githubusercontent.com/microsoft/playwright/main/docs/src/emulation.md ; https://raw.githubusercontent.com/microsoft/playwright/main/docs/src/test-use-options-js.md ; https://raw.githubusercontent.com/microsoft/playwright/main/docs/src/accessibility-testing-js.md
12. `playwright-core` 1.63.0, https://registry.npmjs.org/playwright-core (`types/types.d.ts` comments; `devices` registry loaded locally)
13. `@axe-core/playwright` 4.13.0 (README, `npm view`), https://registry.npmjs.org/@axe-core/playwright ; axe rules https://raw.githubusercontent.com/dequelabs/axe-core/develop/doc/rule-descriptions.md
14. Okabe-Ito hex: R source https://raw.githubusercontent.com/wch/r-source/trunk/src/library/grDevices/R/colorstuff.R ; https://raw.githubusercontent.com/clauswilke/colorblindr/master/R/palettes.R (cites the Okabe and Ito article, not fetched: https://web.archive.org/web/20210108233739/http://jfly.iam.u-tokyo.ac.jp/color/)
15. `tol_colors` 2.2.0 (Paul Tol and Clement Haeck), https://pypi.org/project/tol-colors/ ; sdist https://files.pythonhosted.org/packages/2a/18/c4877a3dfd90a7350da789fb3e23f2a0a711eb13d56f3c9f6ce1aa9876b9/tol_colors-2.2.0.tar.gz (`colors.json`, `docs/source/colorsets.rst`)
16. Flutter constants: https://raw.githubusercontent.com/flutter/flutter/master/packages/flutter/lib/src/material/constants.dart ; https://raw.githubusercontent.com/flutter/flutter/master/packages/flutter/lib/src/cupertino/constants.dart
17. AVIXA DISCAS (search summaries only): https://www.avixa.org/standards/discas-calculators/discas/learn-more-about-display-size ; https://www.avixa.org/resources/display-image-size-calculators/analytical-and-basic-decision-making-calculations ; https://www.avixa.org/standards/display-image-size-for-2d-content-in-audiovisual-system ; https://www.infocomm.org/DiscasCalc/adm.html ; https://webstore.ansi.org/preview-pages/InfoComm/preview_ANSI+INFOCOMM+V202.01-2016.pdf
18. 4-6-8 rule explainers (search summaries only): https://www.slashgear.com/2221483/what-is-4-6-8-rule-for-projectors/ ; https://www.bgr.com/2222593/what-is-the-4-6-8-rule-projectors-explained/
19. AV-INFO, "Projection Rules" (search summary only): https://av-info.eu/video/projectionrules.html
20. DISCAS explainers (search summaries only; per-claim page not identified): https://strongmdi.com/blog/when-bigger-is-better-display-image-size-for-2d-content-in-audiovisual-systems-discas-the-new-infocomm-standard/ ; https://visualdisplaysltd.com/resources/industry-standards/discas
21. Wikipedia, "X-height" (search summary only): https://en.wikipedia.org/wiki/X-height
22. W3C WAI complex-image guidance (search summary; page not identified between these two): https://www.w3.org/WAI/tutorials/images/complex/ ; https://www.w3.org/WAI/WCAG21/Understanding/non-text-content.html
