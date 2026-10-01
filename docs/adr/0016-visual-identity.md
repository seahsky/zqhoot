# ADR-0016: Visual identity and responsive system

Status: accepted (2026-09-29). Source: [responsive-display.md](../research/responsive-display.md) design rules; brand elements to avoid from [kahoot.md](../research/kahoot.md) §11 and [mentimeter.md](../research/mentimeter.md) §9.

## Decision

### Identity (original)

- **Name:** zqhoot (lower-case wordmark set in the UI font). No mascot, no exclamation mark.
- **Answer identity:** letter + shape + position + colour, never colour alone (WCAG 1.4.1).

| Slot | Letter | Glyph                            | Fill                   |
| ---- | ------ | -------------------------------- | ---------------------- |
| 1    | A      | hexagon                          | #0072B2 (blue)         |
| 2    | B      | plus                             | #D55E00 (vermillion)   |
| 3    | C      | five-point star                  | #F0E442 (yellow)       |
| 4    | D      | dome (half-disc, flat side down) | #009E73 (bluish green) |

| 5 (polls only) | E | pentagon | #56B4E9 (sky blue) |
| 6 (polls only) | F | X-cross | #CC79A7 (reddish purple) |

True/false uses slots A and B (hexagon, plus), labelled "True" and "False". There are no check or cross glyphs, so shape never implies correctness.

- Fills only colour glyphs and chart bars, always with a 3-4 px ink outline. Answer text is ink on a neutral card: vermillion and green differ by 1.13:1 in luminance, and yellow is 1.32:1 on white.
- **Colour tokens:**

| Token       | Light stage (default) | Dark stage        |
| ----------- | --------------------- | ----------------- |
| `--bg`      | #FFFFFF               | #0B1020           |
| `--surface` | #F1F4F9               | #141B30           |
| `--ink`     | #0B1020 (18.93:1)     | #F4F6FB (17.51:1) |
| `--ink-2`   | #3A4258 (10.00:1)     | #C3CAD9 (11.51:1) |

- No separate brand accent colour: chrome uses ink, and colour appears only in answer glyphs and charts. We avoid saturated full-bleed backgrounds, which are central to Kahoot's look (purple) and Mentimeter's infographic palette.
- **Type:** the system UI font stack (no web-font dependency, no licensing), with tabular numerals for timers and scores. Weights 500-800, never below 400.
- **Sound:** none in v1. No sound effects or music, so nothing to imitate.
- **Copy:** our own strings, e.g. "You're in", "Options open in 3", "Answer locked", "Time's up", "Round results". None of the strings listed in the research's "do not copy" sections are used.

### Presenter (`/present`)

- A 16:9 stage centred with letterboxing. `container-type: size`, sizes in `cqh` (1 u = 1% of stage height), fallback `min(1vh, 0.5625vw)`. 1366x768, 1920x1080 and 3840x2160 render the same composition.
- Type scale (u): countdown 18, PIN 10, question 7 (auto-fit 5-8), podium names 6.5, answers and leaderboard 5, chart labels 4.5, minimum essential 4.3, meta 3.5.
- Text-size control 100/125/150% and light/dark stage toggle (WCAG F94, projector ambient light).
- Keyboard: Space / → / PageDown = next; Enter = close question; ← does nothing (no going back mid-game); F = fullscreen; T = text size; D = dark/light; L = lock joining. Clickers send PageDown/→.
- Charts: horizontal bars, zero baseline, direct labels "A · text · 14 · 47%", correct answer marked with a text badge "Correct" + thick outline. A hidden table alternative, and a `role="status"` summary updated at most once per second.
- Overscan: the stage keeps a 5 u margin on every side, and all content sits inside it, including the running header (question number and "N of M answered"). Projectors with overscan or keystone correction crop 2-5% of each edge.
- Outlines inside the stage scale with it: `--outline-w` is `max(1px, 0.45u)` on the stage, the same 3-4 px at 1366x768. A fixed pixel outline would cover the colour fills on a small stage (a presenter preview in a narrow window).

### Phone (`/join`, `/play`)

- rem-based sizing, 16 px gutters with `max(16px, env(safe-area-inset-*))`, `min-height: 100vh; min-height: 100svh`.
- Question `clamp(1.25rem, 1.05rem + 1vw, 1.75rem)`, answers 1.125 rem, weight 600. Inputs ≥ 16 px.
- Answer rows ≥ 72 px tall with 12 px gaps, stacked. A 2x2 grid applies above a 420 px container width, and only when every option is ≤ 24 characters. Controls ≥ 48x48 px. `touch-action: manipulation`.
- Viewport: `width=device-width, initial-scale=1, viewport-fit=cover`. Never `maximum-scale` or `user-scalable=no`.
- Status messages ("Answer locked", "Reconnecting…", "Time's up") in `role="status"`.
- On a tablet or laptop, player content sits just below the header rather than being centred, so a heading stays in one place across states. Screens with long answer options get a 40 rem column, so four 80-character options fit above the fold at 1366x768.
- Rating scales of more than five values split into balanced rows (7 is 4 + 3), or use one row when every button fits at 48 px.

### Status indicators (all views)

- A status ("Unsaved changes", "Question open", "Reconnecting…") is text with a leading dot, never an outlined, rounded box: here that shape means a button. The dot is drawn as a border, so forced-colours mode keeps it.
- In forced colours every button uses the button system colours, links styled as buttons included, and the primary action is the one solid block.

### Motion

- `prefers-reduced-motion: reduce`: no scaling or sliding, and the countdown is a numeral updated once per second.
- Nothing flashes. The podium reveal is a fade, and there is no confetti.

### Testing

Six Playwright projects: 320x568, 390x844 (viewport overridden explicitly), 768x1024, 1366x768, 1920x1080, 3840x2160. `@axe-core/playwright` with tags `wcag2a, wcag2aa, wcag21a, wcag21aa, wcag22aa`, a horizontal-scroll assertion on non-presenter views, and screenshots of every view at every breakpoint. The `@axe-core/playwright` version must be compatible with Playwright 1.56.1; the implementer verifies this with `npm view`.

## Consequences

- No web fonts means rendering differs by OS. Projector legibility relies on weight and size, not a specific face.
- The dome and plus glyphs are uncommon in quiz UIs, which is the point, but they need a visible legend on first use ("A ⬡ …").
