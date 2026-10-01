# V2-player-visual: player, join and shared-button findings from the visual check

Owner: Sonnet implementation agent. Reviewer: independent Opus agent. Source: the lead's visual check of the gallery screenshots at every breakpoint (phase 5). Each finding below was confirmed by a second reviewer who opened the images. Their diagnosis of the cause is a lead, not a fact: read the code before relying on it.

## Read first

- `docs/adr/0016-visual-identity.md` (tokens, outlines, forced colours, phone rules)
- `apps/web/src/screens/play/*`, `apps/web/src/screens/join/*`, `apps/web/src/screens/landing/*`, `apps/web/src/ui/*` (the files you own below), `apps/web/src/dev/fixtures/player.ts`

## Files you own

`apps/web/src/screens/play/**`, `apps/web/src/screens/join/**`, `apps/web/src/screens/landing/**`, `apps/web/src/ui/Countdown.*`, `apps/web/src/ui/Button.*`, `apps/web/src/ui/AnswerOption.*`, `apps/web/src/ui/PhoneShell.*`, `apps/web/src/ui/ResultIcon.*`, `apps/web/src/dev/fixtures/player.ts`, and tests for these under `apps/web/test/`.

Other tasks are editing these files at the same time, so don't touch them: `apps/web/src/screens/present/**`, `screens/host/**`, `screens/edit/**`, `ui/tokens.css`, `ui/base.css`, `ui/Stage.*`, `ui/AnswerGlyph.*`, `dev/fixtures/hostSnapshots.ts`. The presenter also renders `ui/Countdown`, so keep any change to it correct inside the presenter stage too: check the `present-*` screenshots.

## Lead's decisions

- **Countdown (VC-15, VC-18, VC-24, VC-30; VC-19, VC-27).**
  - The numeral box fits its digits, so "6 seconds left" is as tight as "14 seconds left". Keep tabular numerals. A one-time shift when the count goes from 10 to 9 is acceptable.
  - The fill starts flush with the track, with no crescent or seam, in every colour mode.
- **Rating scale (VC-20, VC-25).** Rows are balanced (7 gives 4+3, never 5+2), or a single row when all buttons fit at 44 px or more. The end labels sit under the first and last values.
- **Own row and summary (VC-21, VC-22, VC-34).**
  - The player's own row in "Top players" is marked with the text "You" and a heavier outline, not colour alone.
  - The stats card separates its facts clearly, for example as two labelled figures or with a visible divider.
- **Unscored reveal (VC-17, VC-32).**
  - Give it a status card like the sibling reveals: say no points were given for this question and show the current score and rank.
  - Punctuate the heading like its siblings and avoid single-word orphans (`text-wrap: balance` is fine).
  - If the client state already holds what this player submitted, show it; don't add protocol fields for it.
- **Layout on larger screens (VC-28, VC-31, VC-33, VC-13).**
  - On tall viewports, player content sits near the top below the header, not centred in a large empty band.
  - Poll grids use equal row heights.
  - On wide viewports (laptop and up) four long options fit above the fold at 1366x768, for example with a two-column grid.
  - At 320 px, the glyph and letter take less of the option row, so the text column gets about two thirds of it or more. Both stay visible.
- **Get-ready wording (VC-16).** No orphaned "in". Balance the line or keep "open in" together with the number.
- **Forced colours and contrast (VC-23, VC-67, VC-26).**
  - In forced colours, primary buttons stay visibly primary, for example `forced-color-adjust: none` with `ButtonText`/`ButtonFace` swapped, or `Highlight`/`HighlightText`.
  - Every `.button`, including `ButtonLink` anchors, uses button system colours rather than `LinkText`, so buttons in one row match.
  - This is `ui/Button.module.css`. It fixes the host screens too, so V3 won't touch it.
  - Under `prefers-contrast: more`, emphasised containers show one heavy outline, not a double line.
- **Lobby fixture (VC-14, VC-29).** The lobby fixture player has score 0 and no rank. Mid-game fixtures keep their score.

## Findings

### VC-13 (low) play-answer-single-long

- Projects: phone-320. Example: `apps/web/e2e/screenshots/phone-320/play-answer-single-long.png`
- Problem: At 320 px each answer row puts the glyph (~36 px), the letter (24 px) and two 12 px gaps in front of the text, all inside 12 px padding. That leaves the 80-character option text a column of only about 150 px, roughly half the row. Each option wraps to 6 lines, so each row is about 160 px tall and the page is about 1047 px tall, nearly two screens. Reading options C and D scrolls the question, the '21 seconds left' numeral and the bar off-screen, so a player cannot see the timer while choosing. The text stays legible, but the ragged 3-4 word lines are slow to read.
- Expected: At narrow widths, give the text most of the row. For example, shrink the glyph and put the letter next to it in a compact column of about 40 px, or put the glyph and letter on a line above the text, so an 80-char option wraps to about 3 lines. Consider keeping the countdown sticky at the top so it stays visible while the player scrolls long options.
- Verifier's diagnosis (check it; it can be wrong): apps/web/src/ui/AnswerOption.module.css:4 (gap 0.75rem) and :7 (padding 0.75rem), plus :23 (.letter min-width 1.5rem). apps/web/src/ui/AnswerGlyph.tsx:18 renders the glyph at a fixed size of 40 at every width. Nothing compacts the prefix at narrow widths.
- Suggested fix: Add a narrow-width rule to AnswerOption.module.css: `@media (max-width: 359px) { .option { gap: 0.5rem; padding: 0.625rem; } .option > svg { width: 28px; height: 28px; } .letter { min-width: 0; } }`. CSS width and height override the SVG size attributes. This widens the text column by about 30-35 px, so each option loses 1-2 lines. A sticky countdown is optional and belongs in a separate change.

### VC-14 (low) play-lobby

- Projects: phone-320. Example: `apps/web/e2e/screenshots/phone-320/play-lobby.png`
- Problem: The lobby header shows 'Riley 1,240 pts' before the first question has opened (questionIndex -1, the copy says 'The first question will show up here when the host starts the game'). A score in the lobby is impossible and misleading. The cause is the fixture: `you = { score: 1240, rank: 4 }` in apps/web/src/dev/fixtures/player.ts is reused by the lobby snapshot, and also by the kicked, session-over and out-of-date screens that are built from it.
- Expected: In the lobby, the header shows 0 pts or no score. Give the lobby fixture score 0 (and rank null, if the protocol allows it). Alternatively, hide the score in the header while phase is 'lobby'.
- Verifier's diagnosis (check it; it can be wrong): apps/web/src/dev/fixtures/player.ts:23 (`const you = { ...ME, score: 1240, rank: 4, streak: 0 }`) is used by the lobby snapshot at apps/web/src/dev/fixtures/player.ts:109 (`'play-lobby': welcome(snapshot({}))`).
- Suggested fix: apps/web/src/dev/fixtures/player.ts:109: change it to `'play-lobby': welcome(snapshot({ you: { ...you, score: 0, rank: null } })),`. The schema allows a null rank. No change to the app is needed.

### VC-15 (low) play-answer-truefalse

- Projects: phone-320. Example: `apps/web/e2e/screenshots/phone-320/play-answer-truefalse.png`
- Problem: With a single-digit time, '6' is followed by a wide blank gap before 'seconds left'. The numeral box has `min-width: 2ch` and is left-aligned (Countdown.module.css .numeral), so the unit label floats about 30 px away from the number and looks detached or misaligned. It looks fine with two digits (14, 21, 23 on the sibling screens).
- Expected: Keep the unit next to the numeral: right-align the numeral inside its 2ch box, or drop min-width and rely on tabular-nums, so '6 seconds left' reads as one phrase.
- Verifier's diagnosis (check it; it can be wrong): apps/web/src/ui/Countdown.module.css:62 (`.numeral { min-width: 2ch; ... }`) with the default left alignment inside the flex row (lines 55-59).
- Suggested fix: Delete `min-width: 2ch;` at apps/web/src/ui/Countdown.module.css:62 and keep `font-variant-numeric: tabular-nums`.

### VC-16 (low) play-get-ready

- Projects: phone-320. Example: `apps/web/e2e/screenshots/phone-320/play-get-ready.png`
- Problem: In the get-ready card, 'Get ready: options open in' wraps so 'in' sits alone on the second line, with the '3' below on a third line. It reads as a broken sentence ('...open / in / 3').
- Expected: Keep 'in' with the numeral: put the number inline ('Options open in 3'), use a non-breaking space before 'in', or shorten the label so it fits on one line at 320 px.
- Verifier's diagnosis (check it; it can be wrong): apps/web/src/screens/play/GetReady.tsx:20 (label copy 'Get ready: options open in'). Combined with apps/web/src/screens/play/GetReady.module.css:31-34 (flex, flex-wrap: wrap, gap), the long text item wraps before the numeral does.
- Suggested fix: Shorten the copy at apps/web/src/screens/play/GetReady.tsx:20 to `Options open in{' '}`. It is about 160 px plus the numeral, which fits on one line at 320 px, and the card already reads as a get-ready state.

### VC-17 (low) play-reveal-unscored

- Projects: phone-320. Example: `apps/web/e2e/screenshots/phone-320/play-reveal-unscored.png`
- Problem: The poll reveal ('reveal, no points') shows only an icon and 'Thanks, your response is in' in the middle of a mostly empty screen. It does not show what the player chose or any result. It reads like the 'answer locked' state rather than a reveal, and the large blank areas above and below make the screen look unfinished next to its sibling reveal screens.
- Expected: Show the player's pick (glyph, letter and text), and optionally a line such as 'This one isn't scored'. That makes it a clear reveal state consistent with the other reveal screens.
- Verifier's diagnosis (check it; it can be wrong): apps/web/src/state/format.ts:42 (unscored headline repeats the locked-in copy). apps/web/src/screens/play/Reveal.tsx:32-44 renders nothing more for variant 'unscored', since there is no correct answer and scored is false.
- Suggested fix: In apps/web/src/screens/play/Reveal.tsx after line 23, add `{variant === 'unscored' && <p className={styles.lead}>No points for this one. The results are on the big screen.</p>}`. Optionally change format.ts:42 to a reveal-specific headline such as 'Results are in'.

### VC-18 (low) play-answer-truefalse

- Projects: phone-390, phone-390-dark. Example: `apps/web/e2e/screenshots/phone-390/play-answer-truefalse.png`
- Problem: A single-digit countdown ('6') keeps a two-digit-wide slot, so a large gap (about 70 px on screen) opens between the numeral and 'seconds left'. On sibling screens with two-digit timers (14, 21, 23, 33, 70) the label sits right next to the number, so this one looks misaligned or broken.
- Expected: Right-align the numeral in its fixed-width slot, or let the slot shrink to fit, so 'seconds left' keeps the same small gap after the number whatever the digit count.
- Verifier's diagnosis (check it; it can be wrong): apps/web/src/ui/Countdown.module.css:13-19: `.numeral { min-width: 2ch; ... }`. The min-width keeps a 2ch slot to stop jitter between 10 and 9, but the text is left-aligned inside it.
- Suggested fix: In apps/web/src/ui/Countdown.module.css .numeral (line 14), add `text-align: right;` next to `min-width: 2ch;`. The digit then sits against the label with the usual 0.5rem gap, and the label still does not move when the count drops from two digits to one. Alternatively, remove `min-width: 2ch` so the slot shrinks to fit.

### VC-19 (low) play-answer-single / truefalse / poll-6 / wordcloud / open / submitted / reconnecting (timer bar)

- Projects: phone-390, phone-390-dark. Example: `apps/web/e2e/screenshots/phone-390-dark/play-answer-single.png`
- Problem: At the left end of the countdown progress bar, a thin grey crescent/hairline shows inside the fill (a visible '(' seam), because the fill's rounded end is inset from the track's rounded border. It shows on every timed screen in both schemes and is most visible in dark mode (grey line on the white fill).
- Expected: The fill should sit flush with the track at the left end with no seam, for example by clipping the fill with overflow:hidden on the track and matching border radii, or by removing the inset.
- Verifier's diagnosis (check it; it can be wrong): apps/web/src/ui/Countdown.module.css:33-46: `.bar` has `border: var(--outline-w) solid var(--ink); border-radius: 999px; overflow: hidden;` and `.fill` has `border-radius: 999px`. Two separately anti-aliased curves (the border's inner edge / padding-box clip and the fill's rounded cap) meet at the same place, and `.bar`'s var(--bg) background shows through the partly covered pixels.
- Suggested fix: Let the fill cover the track's left border so no edge pixels are left uncovered. `.fill` is var(--ink), the same colour as the border, so the overlap is invisible. In Countdown.module.css, remove `overflow: hidden` from `.bar` (line 38) and add `margin-left: calc(-1 * var(--outline-w));` to `.fill` (lines 41-46). The fill cannot exceed the track, because its width is at most 100% and the negative margin moves it inward. An alternative is to drop the .fill div and paint the progress as `.bar { background: linear-gradient(to right, var(--ink) var(--p), var(--bg) 0) border-box; }` with `--p` set inline, so the fill runs under the border.

### VC-20 (low) play-answer-rating

- Projects: phone-390, phone-390-dark. Example: `apps/web/e2e/screenshots/phone-390/play-answer-rating.png`
- Problem: The 1-7 scale wraps as 5 buttons, then 2 orphaned buttons (6, 7) aligned left, leaving an empty right half on the second row. The scale no longer reads as one continuous line from 'Not at all likely' to 'Extremely likely', and 7 does not sit above its end label on the right.
- Expected: Lay the scale out as one row that fits (seven buttons at least 44-48 px with smaller gaps), or as a balanced 4 + 3 grid, or as a vertical list, so the order and the end labels stay clear.
- Verifier's diagnosis (check it; it can be wrong): apps/web/src/screens/play/RatingScale.module.css:13-17: `.buttons { grid-template-columns: repeat(auto-fill, minmax(3.5rem, 1fr)); gap: var(--gap); }`. With a content width of about 358 px, 12 px gaps and a 56 px minimum, only 5 columns fit, so 7 values split 5+2. The same rule gives uneven splits for other maxima (ratings allow 3-10 per packages/protocol/src/limits.ts:32-33).
- Suggested fix: Set the column count so the rows come out balanced. In RatingScale.tsx:21, add `style={{ '--cols': max <= 5 ? max : Math.ceil(max / 2) } as React.CSSProperties}` to the `.buttons` div. In RatingScale.module.css:15, change the rule to `grid-template-columns: repeat(var(--cols), minmax(0, 1fr));`. That gives 7 as 4+3, 10 as 5+5 and 6 as 3+3, with the values kept in reading order. Alternatively, for one row up to 7 values, use `minmax(2.75rem, 1fr)` with `gap: 0.5rem`, which fits 7 × 44 px in 358 px.

### VC-21 (low) play-reveal-correct / play-reveal-incorrect / play-reveal-no-answer / play-ended (stats card)

- Projects: phone-390, phone-390-dark. Example: `apps/web/e2e/screenshots/phone-390/play-reveal-correct.png`
- Problem: The summary card shows two separate facts run together on one line, separated only by whitespace ('2,340 points 2nd place', '4,560 points 7 of 10 correct'), with no divider or label. It reads like a garbled sentence, and the right part of the card is left empty.
- Expected: Separate the two values visibly (a divider, a middle dot, or two stacked label/value pairs such as 'Score 2,340' / 'Place 2nd') so they read as distinct stats.
- Verifier's diagnosis (check it; it can be wrong): apps/web/src/screens/play/play.module.css:59-69: `.stat` is a flex row of plain spans with only `gap: 0.5rem 1rem`. The markup is at apps/web/src/screens/play/Reveal.tsx:40-43 and apps/web/src/screens/play/Ended.tsx:17-24.
- Suggested fix: Add a visible divider between the stats and a real text separator. In play.module.css, add `.stat > span + span { padding-left: 1rem; border-left: var(--outline-w) solid var(--ink); }`. In Reveal.tsx:42 and Ended.tsx:20, put `{' '}` (or `<span aria-hidden="true"> · </span>`) between the two spans so the accessible text reads '2,340 points, 2nd place'. Another option is to stack the values as label/value pairs (for example 'Score' / '2,340').

### VC-22 (low) play-ended

- Projects: phone-390, phone-390-dark. Example: `apps/web/e2e/screenshots/phone-390/play-ended.png`
- Problem: In the 'Top players' list, the player's own row ('3rd Riley 4,560') is styled exactly like the other players' rows, with no 'You' marker or heavier outline, so the player cannot spot themselves at a glance.
- Expected: Mark the current player's row with a non-colour cue, such as a 'You' text badge or a thicker outline, in both schemes.
- Verifier's diagnosis (check it; it can be wrong): apps/web/src/screens/play/Ended.tsx:30-35 renders every podium entry with the same `styles.row` class and no self-marker. apps/web/src/screens/play/PlayScreen.tsx:53 renders `<Ended view={view} />` without passing `state.me`, and PlayerView 'ended' (state/player.ts:121-125) carries no id for the current player.
- Suggested fix: Pass the player's id and mark the matching row. In PlayScreen.tsx:53, change to `<Ended view={view} meId={state.me?.playerId} />`. In Ended.tsx:31, give the matching entry an extra class, `aria-current="true"` and a text badge: `<li className={cx(styles.row, entry.playerId === meId && styles.me)} aria-current={entry.playerId === meId || undefined}>` … `{entry.nickname}{entry.playerId === meId && <span className={styles.youBadge}> (You)</span>}`. In play.module.css, add `.me { border-width: calc(var(--outline-w) * 2); }` so the row has a cue that does not rely on colour in both schemes.

### VC-23 (medium) landing, join-pin, join-pin-error, join-nickname, play-ended, play-kicked, play-session-over, play-out-of-date

- Projects: phone-390-forced-colors. Example: `apps/web/e2e/screenshots/phone-390-forced-colors/landing.png`
- Problem: In forced colours the filled primary button loses its fill, so primary and secondary actions become identical outlined boxes. Colours also vary by element type rather than by role. On landing, 'Join a game' and 'Host a game' are both blue (LinkText) outlines with nothing to show which is primary. On join-pin, 'Continue' is black and 'Back' is blue. On join-nickname, 'Join' and 'Use a different PIN' are both black. The single primary action is blue on play-ended, play-kicked and play-session-over but black on play-out-of-date ('Reload'). Sibling screens therefore look inconsistent, and the primary action's emphasis is lost.
- Expected: Give the primary action a forced-colours-safe cue, for example a thicker border or a ButtonText/ButtonFace swap with forced-color-adjust scoped to the button. Give link-styled and button-styled actions the same system colour so that equivalent actions look the same across screens.
- Verifier's diagnosis (check it; it can be wrong): apps/web/src/ui/Button.module.css:20-23 (.primary uses background: var(--ink); color: var(--bg), which forced colours override). The file has no @media (forced-colors: active) block, unlike AnswerOption, Countdown and TextField. ButtonLink (Button.tsx) renders an <a>, so it picks up LinkText, while Button renders <button> with ButtonText.
- Suggested fix: Append to Button.module.css: `@media (forced-colors: active) { .button { color: ButtonText; border-color: ButtonText; } .primary { forced-color-adjust: none; background: ButtonText; color: ButtonFace; border-color: ButtonText; } .button:disabled, .button[aria-disabled='true'] { forced-color-adjust: auto; color: GrayText; border-color: GrayText; background: ButtonFace; } }`. The primary becomes a solid system-colour fill, and link and button actions share the ButtonText/ButtonFace roles.

### VC-24 (low) play-answer-truefalse

- Projects: phone-390-forced-colors, phone-390-high-contrast. Example: `apps/web/e2e/screenshots/phone-390-forced-colors/play-answer-truefalse.png`
- Problem: With a single-digit countdown ('6'), the number sits at the left of a fixed two-digit box, leaving a wide gap before 'seconds left'. This does not match the tight '14 seconds left' / '23 seconds left' spacing on the sibling screens and looks misaligned.
- Expected: Right-align the digits inside the tabular-width box, or size the box to its content, so that the gap between the numeral and 'seconds left' stays the same.
- Verifier's diagnosis (check it; it can be wrong): apps/web/src/ui/Countdown.module.css:13-19. .numeral has min-width: 2ch and no text-align, so a single digit is left-aligned inside the 2ch box.
- Suggested fix: Add `text-align: end;` to .numeral in Countdown.module.css:13-19. It is a flex item, so it is blockified and text-align applies. The digit then sits against 'seconds left' and the numeral-to-label gap stays constant, while the reserved width still prevents layout shift.

### VC-25 (low) play-answer-rating

- Projects: phone-390-forced-colors, phone-390-high-contrast. Example: `apps/web/e2e/screenshots/phone-390-forced-colors/play-answer-rating.png`
- Problem: The 1-7 scale wraps into a row of five and an orphan row of two (6, 7). The end label '7: Extremely likely' is right-aligned under empty space, far from the 7 button at the left of row two, so the scale no longer reads as a left-to-right continuum.
- Expected: Keep the 7 buttons in one row at 390 px (7 x 48 px plus gaps fits), or use a balanced grid such as 4+3, and place the end labels next to the buttons they describe.
- Verifier's diagnosis (check it; it can be wrong): apps/web/src/screens/play/RatingScale.module.css:13-17. .buttons uses grid-template-columns: repeat(auto-fill, minmax(3.5rem, 1fr)), so as many 56 px columns as fit (5) are created, leaving an unbalanced remainder row.
- Suggested fix: Choose a balanced column count in RatingScale.tsx and pass it as a custom property, for example `const cols = max <= 5 ? max : Math.ceil(max / Math.ceil(max / 5));` and `style={{ '--cols': cols } as React.CSSProperties}` on the group div. Change RatingScale.module.css:15 to `grid-template-columns: repeat(var(--cols), minmax(0, 1fr));`. That gives 4 + 3 for 7 and 5 + 5 for 10.

### VC-26 (low) join-pin-error, join-nickname-error, play-submitted

- Projects: phone-390-high-contrast. Example: `apps/web/e2e/screenshots/phone-390-high-contrast/play-submitted.png`
- Problem: Under prefers-contrast: more, the emphasised containers (the invalid PIN and nickname inputs, and the 'Answer locked in' card) show a thick outer border with a second thin line just inside it. This looks like a double-rendered border or artefact rather than one deliberate heavy outline. The forced-colours captures show a single clean 6 px border.
- Expected: Draw a single solid heavy outline in high-contrast mode, without an inset box-shadow or a second border stacked on the first.
- Verifier's diagnosis (check it; it can be wrong): apps/web/src/ui/TextField.module.css:31-33 (.control[aria-invalid='true'] { box-shadow: inset 0 0 0 3px var(--ink); }) and apps/web/src/ui/AnswerOption.module.css:38-40 (.chosen { box-shadow: inset 0 0 0 3px var(--ink); }). The inset shadow's rounded edge and the border's inner rounded edge are anti-aliased separately, which leaves a light seam at the corners.
- Suggested fix: Replace each inset shadow with a thicker border and compensate the padding so content does not shift. In TextField.module.css:31-33 use `.control[aria-invalid='true'] { border-width: calc(var(--outline-w) + 3px); padding: calc(0.75rem - 3px) calc(1rem - 3px); }`. In AnswerOption.module.css:38-40 use `.chosen { border-width: calc(var(--outline-w) + 3px); padding: calc(0.75rem - 3px); }`. The forced-colors 6px overrides can then be removed or kept.

### VC-27 (low) play-get-ready, play-answer-single, play-answer-single-long, play-answer-truefalse, play-answer-poll-6, play-answer-wordcloud, play-answer-open, play-submitted, play-reconnecting

- Projects: phone-390-forced-colors, phone-390-high-contrast. Example: `apps/web/e2e/screenshots/phone-390-forced-colors/play-answer-single.png`
- Problem: The countdown bar fill does not start flush with the track: at the left end a thin white crescent shows between the track border and the rounded fill. It is visible on every timed screen in both modes.
- Expected: Inset the fill to match the track's inner radius, or clip it with overflow: hidden on the track, so that the fill meets the left edge cleanly.
- Verifier's diagnosis (check it; it can be wrong): apps/web/src/ui/Countdown.module.css:33-46. .bar draws the track with `border: var(--outline-w) solid var(--ink); border-radius: 999px; overflow: hidden`, and .fill is a separate rounded ink box inside the padding box. Two independently anti-aliased curves meet at the left end.
- Suggested fix: Draw the track outline above the fill so the seam is covered. In .bar (Countdown.module.css:33-39) replace `border: var(--outline-w) solid var(--ink);` with `outline: var(--outline-w) solid var(--ink); outline-offset: calc(-1 * var(--outline-w));`. Outlines paint after content and follow border-radius, and they survive forced colours. The fill is then clipped at the outer curve and overpainted by the outline ring, leaving one clean edge.

### VC-28 (low) play-* (all player screens), join-pin, join-nickname, landing

- Projects: tablet-768, laptop-1366. Example: `apps/web/e2e/screenshots/tablet-768/play-times-up.png`
- Problem: The player header stays at the top, but the page body is centred vertically in the rest of the viewport. On the 768x1024 tablet this leaves a blank band of about 300-450 CSS px between the header rule and the first line of content (e.g. play-times-up: header ends at y≈50, 'Question 3 of 10' starts at y≈455; play-lobby, play-kicked, play-out-of-date and play-session-over look the same), plus a matching empty area below. Because each state centres its own content, the question heading also jumps between sibling states (answer-single ≈y350, get-ready ≈y390, submitted ≈y415, reveal-correct ≈y410 in CSS px). join-pin and join-pin-error move by about 15px when the error line appears. On the 1366x768 laptop the gap is smaller (≈150-250px) but still there.
- Expected: Top-align the content under the header, or cap the offset (e.g. align-content: start with a modest padding-top, or centre only up to a max offset), so the question and status sit at a steady, predictable position and the tablet page does not look half-empty.
- Verifier's diagnosis (check it; it can be wrong): apps/web/src/ui/PhoneShell.module.css:75-79. Above the 700px breakpoint, `.main::before, .main::after { content:''; flex: 1 1 0; }` split all the free height evenly above and below the content, so every screen is vertically centred and the top offset depends on how tall the content is.
- Suggested fix: Cap the top spacer so the content sits a short, steady distance under the header and the bottom spacer takes the rest. In the same media block add `.main::before { max-height: clamp(1rem, 6vh, 4rem); }` and keep `.main::after` as `flex: 1 1 0`.

### VC-29 (low) play-lobby

- Projects: tablet-768, laptop-1366. Example: `apps/web/e2e/screenshots/laptop-1366/play-lobby.png`
- Problem: The lobby header shows '1,240 pts' next to 'You're in. Watch the big screen. The first question will show up here when the host starts the game.' No question has been played yet, so a non-zero score contradicts the state the screen describes. The fixture reuses the mid-game player (score 1240) for the lobby.
- Expected: The lobby fixture (and a real lobby) should show 0 pts, or leave the score out of the header until the first question is scored.
- Verifier's diagnosis (check it; it can be wrong): apps/web/src/dev/fixtures/player.ts:23 (`const you = { ...ME, score: 1240, rank: 4, streak: 0 }`), used as the default by `snapshot()` at :25-36, and at :109 (`'play-lobby': welcome(snapshot({}))`).
- Suggested fix: Give the lobby-phase fixtures a zero score, e.g. at player.ts:109 `'play-lobby': welcome(snapshot({ you: { ...you, score: 0, rank: null } }))` (or rank 1 if the schema needs a number). The simplest option is to make `snapshot()` default to `{ ...ME, score: 0, rank: null, streak: 0 }` and pass `you` explicitly from `questionSnapshot`. Do the same for kicked/session-over/out-of-date if they are meant to happen from the lobby.

### VC-30 (low) play-answer-truefalse

- Projects: tablet-768, laptop-1366. Example: `apps/web/e2e/screenshots/laptop-1366/play-answer-truefalse.png`
- Problem: With a one-digit countdown ('6'), the 'seconds left' label sits about one character-width away from the number ('6 seconds left'). With two digits ('14 seconds left', '21 seconds left') the spacing is normal. The number box has a fixed minimum width, which leaves a hole when only one digit shows.
- Expected: Keep the same visual gap between the number and the label whatever the digit count (e.g. right-align the numeral inside its fixed box, or drop the min-width and rely on tabular numerals).
- Verifier's diagnosis (check it; it can be wrong): apps/web/src/ui/Countdown.module.css:14 (`.numeral { min-width: 2ch; }`) together with the left-aligned flex row at :7-11.
- Suggested fix: Remove `min-width: 2ch` from `.numeral` (Countdown.module.css:14). `font-variant-numeric: tabular-nums` already keeps the width stable while the digit count stays the same. The label then moves only once, when the count drops from 10 to 9.

### VC-31 (low) play-answer-poll-6

- Projects: tablet-768, laptop-1366. Example: `apps/web/e2e/screenshots/tablet-768/play-answer-poll-6.png`
- Problem: In the 2-column grid, 'F Veggie sticks' wraps to two lines, so the F tile is taller than the E 'Mixed nuts' tile beside it and the bottom edges of the last row do not line up. Rows A/B and C/D have equal heights, so the last row looks broken.
- Expected: Stretch the tiles in each grid row to the same height (align-items: stretch / grid-auto-rows: 1fr), so a wrapped label in one tile does not break the row.
- Verifier's diagnosis (check it; it can be wrong): apps/web/src/screens/play/ChoiceList.module.css:5-9 (the grid stretches the `<li>` from ChoiceList.tsx:24, not the button inside it) together with apps/web/src/ui/AnswerOption.module.css:1-15 (`.option` has no height:100%).
- Suggested fix: Make the list items pass their stretched height to the button, e.g. add `.list > li { display: grid; }` to ChoiceList.module.css, or `height: 100%` on `.option` in AnswerOption.module.css.

### VC-32 (low) play-reveal-unscored

- Projects: tablet-768, laptop-1366. Example: `apps/web/e2e/screenshots/tablet-768/play-reveal-unscored.png`
- Problem: The reveal for an unscored poll only repeats the submission message 'Thanks, your response is in'. The heading has no final period and leaves a single-word orphan 'in' on the second line at both widths. Unlike the sibling reveal screens (correct, incorrect, no answer), it has no status card and does not say that no points were given or what happens next. It looks the same as a submitted state, not a reveal.
- Expected: Use reveal-specific copy, e.g. 'No points for this one. See the results on the big screen.', match the structure of the sibling reveal screens, and balance the heading wrap (text-wrap: balance) so the orphan goes away.
- Verifier's diagnosis (check it; it can be wrong): apps/web/src/state/format.ts:42 (`unscored: 'Thanks, your response is in'`), and apps/web/src/screens/play/play.module.css:10-15 (`.title` has no `text-wrap: balance`). apps/web/src/screens/play/Reveal.tsx:39-45 renders nothing else when `scored` is false.
- Suggested fix: Change format.ts:42 to reveal-specific copy, e.g. 'Thanks for voting'. In Reveal.tsx, when `!scored`, add `<p className={`${styles.lead} ${styles.muted}`}>No points for this one. The results are on the big screen.</p>`. Add `text-wrap: balance;` to `.title` in play.module.css:10.

### VC-33 (low) play-answer-single-long

- Projects: laptop-1366. Example: `apps/web/e2e/screenshots/laptop-1366/play-answer-single-long.png`
- Problem: At 1366x768 the page scrolls to 833px tall: option D's card ends at y≈800, below the fold, while about 430px of empty space sits on each side of the 512px column. On a laptop the player has to scroll to see the last option of a timed question.
- Expected: On wide, short viewports, widen the player column (e.g. up to about 640-720px) or tighten the vertical spacing, so four 80-character options and the timer fit in 768px without scrolling.
- Verifier's diagnosis (check it; it can be wrong): apps/web/src/ui/PhoneShell.module.css:51 (`.column { max-width: 32rem; }`), which also applies inside the wide/landscape media block at :67. The narrow column makes the prompt wrap to 3 lines and each option to 3 lines.
- Suggested fix: Inside the `@media (min-width: 700px) and (...)` block in PhoneShell.module.css add `.column { max-width: 40rem; }`. That lets the prompt fit on 2 lines and each option on 2, saving roughly 120px, so everything fits in 768px.

### VC-34 (low) play-ended

- Projects: tablet-768, laptop-1366. Example: `apps/web/e2e/screenshots/tablet-768/play-ended.png`
- Problem: In the 'Top players' list, the player's own row ('3rd Riley 4,560') looks exactly like the Ana and Jo rows, with the same border, fill and weight. Nothing in the list marks it as 'you'.
- Expected: Mark the viewer's own row with a non-colour cue, such as a thicker outline like the locked-answer card, a 'You' tag, or both.
- Verifier's diagnosis (check it; it can be wrong): apps/web/src/screens/play/Ended.tsx:31 renders every podium entry with the same `styles.row`, and Ended never receives the viewer's playerId (PlayScreen.tsx:53 passes only `view`). Row style: apps/web/src/screens/play/play.module.css:84-94.
- Suggested fix: Pass `meId={state.me?.playerId}` from PlayScreen to `<Ended>`. In Ended.tsx:31 set `className={cx(styles.row, entry.playerId === meId && styles.mine)}` and `aria-current={entry.playerId === meId || undefined}`, and append a `<span className={styles.muted}>(you)</span>` after the nickname. In play.module.css add `.mine { box-shadow: inset 0 0 0 3px var(--ink); }` with a forced-colors fallback of `border-width: 6px`.

### VC-67 (low) host-dashboard, host-live-lobby, host-live-question, host-live-reveal

- Projects: phone-390-forced-colors. Example: `apps/web/e2e/screenshots/phone-390-forced-colors/host-dashboard.png`
- Problem: In forced colours, primary actions lose their filled style and look the same as secondary buttons ('Start session' vs 'Duplicate'; 'Start', 'End question' and 'Leaderboard' are just bigger outlined boxes). Meanwhile, link-buttons ('Edit', 'Open control', 'New quiz') turn LinkText blue while real buttons stay black, so buttons in the same row have mismatched colours.
- Expected: In forced-colors mode, mark primary buttons with a thicker border or Highlight/HighlightText colours, and give button-styled links ButtonText/ButtonBorder so a row's actions look alike.
- Verifier's diagnosis (check it; it can be wrong): apps/web/src/ui/Button.module.css:20-23. .primary relies only on background and color, and the file has no forced-colors rule. ButtonLink (apps/web/src/ui/Button.tsx:46-53) renders an <a> with the same classes, so the system maps it to LinkText.
- Suggested fix: Add to Button.module.css: `@media (forced-colors: active) { .button { color: ButtonText; border-color: ButtonText; } .primary { forced-color-adjust: none; background: ButtonText; color: ButtonFace; border-color: ButtonText; } }`. Alternatively, give .primary `border-width: calc(var(--outline-w) * 2)` in forced colours.

## Acceptance criteria

1. Every finding above is fixed as the lead's decisions say. If you conclude a finding is wrong, don't change code for it. Record it as a deviation with the evidence.
2. `pnpm --filter @zqhoot/web typecheck`, `pnpm --filter @zqhoot/web test` (includes the source scan) and `pnpm format:check` pass.
3. The gallery suite passes on all projects: `ZQ_E2E_PORT=4182 pnpm --filter @zqhoot/web test:e2e`. Other tasks run their own suites in parallel on other ports, so always set `ZQ_E2E_PORT=4182` for this task, for every Playwright run, including reviewers'. It takes about 9 minutes and covers axe, horizontal overflow and screenshots. Run it once at the end. While iterating, filter with `--grep <screen-id>` and `--project <name>`.
4. After the final run, open the regenerated screenshots in `apps/web/e2e/screenshots/<project>/<screen>.png` with the Read tool: every screen and project a finding names, plus the same screens at `phone-320`, `laptop-1366` and `uhd-3840`. Confirm each fix and check that nothing else on those screens got worse. List what you inspected in the report. Reviewers do the same.
5. No changes outside the files you own. No changes to `packages/*`, the servers, or the wire protocol.
6. Don't copy another product's look (hard requirement 6). Follow ADR-0016: colour is never the only cue, answers keep their letter and glyph, phones use rem, the presenter stage uses stage units.
