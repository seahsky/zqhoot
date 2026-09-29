# V1-presenter-visual: presenter findings from the visual check

Owner: Sonnet implementation agent. Reviewer: independent Opus agent. Source: the lead's visual check of the gallery screenshots at every breakpoint (phase 5). Each finding below was confirmed by a second reviewer who opened the images. Their diagnosis of the cause is a lead, not a fact: read the code before relying on it.

## Read first

- `docs/adr/0016-visual-identity.md` (stage units, outlines, answer glyphs, overscan-safe area)
- `docs/research/responsive-display.md` (projector safe area, "keep essential content in the inner 90%")
- `apps/web/src/screens/present/*`, `apps/web/src/ui/Stage.*`, `apps/web/src/dev/PresentFixture.tsx`, `apps/web/src/dev/fixtures/present.ts`
- `apps/web/e2e/present.spec.ts` and `apps/web/test/present-layout.test.ts` (the fitting rules you must keep green)

## Files you own

`apps/web/src/screens/present/**`, `apps/web/src/ui/Stage.tsx`, `apps/web/src/ui/Stage.module.css`, `apps/web/src/dev/PresentFixture.tsx`, `apps/web/src/dev/fixtures/present.ts`, `apps/web/test/present*.test.ts`, `apps/web/e2e/present.spec.ts`.

Other tasks are editing these files at the same time, so don't touch them: `apps/web/src/ui/AnswerGlyph.*`, `ui/Countdown.*`, `ui/Button.*`, `ui/tokens.css`, `ui/base.css`, `apps/web/src/dev/fixtures/hostSnapshots.ts`. If a fix seems to need one of them, override the token or rule inside the presenter stage's own scope, e.g. set `--outline-w` on the stage element.

## Lead's decisions

- **Safe area (VC-00).** The running header (question number and the live answer count) moves inside the stage's top safe area and follows the normal flow, in line with the lobby, leaderboard and podium. Take its height out of the fitting budgets (`questionFit.ts`, the chart heights in `Question.tsx` and `Reveal.tsx`) so no question layout overflows. The fitting tests must still pass, updated only where the budget change requires it.
- **Outlines scale with the stage (VC-05, VC-08, VC-09, VC-60).** Inside the presenter stage, every outline and border width (answer glyph outlines, the thicker correct-answer outline, chart bar outlines, the countdown bar, the "+N more" chip) is proportional to the stage. It matches today's width on a 1366x768 stage and never drops below 1px. At 320 px the glyph fills and bars must show their colour, and the countdown bar must show filled and empty parts. Do it by setting the width variables on the stage scope, not by editing `ui/AnswerGlyph.module.css`.
- **Answer count wording (VC-02).** Use one phrasing on every presenter screen: "N of M answered", with digit grouping. The live counter can keep its position on question screens. The fixture player totals are fixed by the V3 task, so leave them.
- **Leaderboard zero gain (VC-04).** Show "+0" in secondary ink instead of an empty cell.
- **Control bar (VC-11, VC-12).**
  - Buttons get a visible gap and wrap tidily at 320 px.
  - The gallery fixture computes the primary label with the same function the real page uses (extract it from `PresentPage.tsx` into a pure, unit-tested function if it isn't one yet). The fixture's ended and podium screens then show what a real host would see.
  - "Lock joining" is hidden once the game has ended, in the real page and in the fixture.
- **Help dialog (VC-03, VC-07).** Size the dialog to the viewport, not the 16:9 stage. On short screens it scrolls inside itself, and the title, every row and Close are always reachable. Size the key column to its content. Close keeps a single focus ring.
- **Open-ended wall at small sizes (VC-06).** Response cards never overlap the pager. At any stage size the grid gets only the height left above the pager and the answer count, and pages accordingly.

## Findings

### VC-00 (medium) present-get-ready, present-question-open, present-question-image, present-question-long, present-reveal-single, present-reveal-truefalse, present-reveal-poll, present-wordcloud, present-open, present-rating

- Projects: laptop-1366, hd-1920. Example: `apps/web/e2e/screenshots/laptop-1366/present-question-image.png`
- Problem: On every question and results screen the eyebrow line ('Question 3 of 10', 'Question 3 of 10 · Results') and the answer count ('12 / 22 answered', '377 / 400 answered') sit flush against the top edge of the stage: about 5-10 px at 1366x768 and about 8 px at 1920x1080. The side gutters are about 5% (69 px and 96 px). The sibling screens (lobby, leaderboard, podium) have about 40-55 px of top padding. Projectors with overscan or keystone correction usually crop 2-5% of each edge, so the question number and the answer count, one of the key readouts, are the first things to be cut off.
- Expected: Use the same safe-area top padding as the side gutter (about 5u) on every presenter screen, so the eyebrow and answer count sit well inside the stage and line up with the lobby, leaderboard and podium.
- Verifier's diagnosis (check it; it can be wrong): apps/web/src/screens/present/Present.module.css:37-57. `.eyebrow { position:absolute; top: calc(var(--u) * -4.3) }` and `.countTop { position:absolute; top: calc(var(--u) * -4.5) }` pull both lines up into the stage's 5u top padding (ui/Stage.module.css `.body` padding 5u), leaving them about 0.5-0.7u from the edge. They are used by Question.tsx:90-97 and Reveal.tsx:47-49.
- Suggested fix: Put the running header in the normal flow. Wrap the eyebrow and count in one row (`.topline { display:flex; justify-content:space-between; align-items:baseline; }`) as the first child of `.screen`, and change `.eyebrow` and `.countTop` to `position: static` (drop the negative `top`). Then take the row's height (about 4.5u plus the 2u screen gap) out of the fitting budgets so nothing overflows: questionFit.ts `optionFit` `const budget = CONTENT_HEIGHT_U - headU - GAP_U` (subtract about 6.5u more), Question.tsx `chartHeightU`, and Reveal.tsx `chartHeightU`.

### VC-02 (low) present-question-image, present-question-long, present-question-open vs present-reveal-*, present-wordcloud, present-open, present-rating

- Projects: laptop-1366, hd-1920. Example: `apps/web/e2e/screenshots/hd-1920/present-reveal-single.png`
- Problem: The answer count changes wording, position and colour between sibling screens. On question screens it reads '12 / 22 answered' at the top right in ink. On results screens it reads '30 of 32 answered' at the bottom left in ink-2. The fixture game also switches from 22 players (lobby, questions, ended screen) to 32 players on every results screen, so the totals don't match within one session.
- Expected: Use one format (for example '30 of 32 answered') and one position for the answer count on all presenter screens, and use a consistent player total across the fixture states of the same game.
- Verifier's diagnosis (check it; it can be wrong): apps/web/src/screens/present/Question.tsx:86 builds `${answered} / ${totalPlayers} answered`. apps/web/src/screens/present/Reveal.tsx:61-65 renders `{answered} of {totalPlayers} answered` in `.footer` (Present.module.css:333-341, colour var(--ink-2), 3.5u). The fixture totals come from apps/web/src/dev/fixtures/hostSnapshots.ts:260-344 (totalPlayers: 32), while present.ts uses roster(22) and roster(400).
- Suggested fix: Use one phrasing. For example, change Question.tsx:86 to `${groupDigits(view.answered)} of ${groupDigits(view.totalPlayers)} answered`, or make Reveal.tsx:63 use ' / '. Optionally, for a coherent gallery, set totalPlayers to 22 in the *_RESULT fixtures in hostSnapshots.ts, scaling answered and the counts to 22 or fewer.

### VC-03 (low) present-help

- Projects: laptop-1366, hd-1920. Example: `apps/web/e2e/screenshots/laptop-1366/present-help.png`
- Problem: The keyboard help dialog gives the key column about half the dialog width, leaving a wide empty gap between the key caps and the descriptions. As a result 'Text size: 100%, 125%, 150%' wraps and leaves '150%' alone on its own line. The 'Next: start, show results, leaderboard, next question' description also doesn't line up with its stacked Space / → / Page Down keys.
- Expected: Size the key column to its content (or about a third of the width) so descriptions fit on one line and align with the top of their key row.
- Verifier's diagnosis (check it; it can be wrong): apps/web/src/screens/present/HelpOverlay.module.css:34-35. `.row { grid-template-columns: calc(var(--u) * 50) minmax(0, 1fr); align-items: center; }` fixes the key column at 50u of the dialog's 112u content width (the dialog is 120u wide with 4u side padding, lines 3 and 6). That leaves the descriptions about 60u, which is too narrow for 'Text size: 100%, 125%, 150%' at 3.8u.
- Suggested fix: In HelpOverlay.module.css:34-35 use `grid-template-columns: calc(var(--u) * 30) minmax(0, 1fr); align-items: baseline;` (or `start`). Space+→ still fits on one line and Page Down on the next, the descriptions get about 80u and fit on one line, and each description aligns with the first key row.

### VC-04 (low) present-leaderboard

- Projects: laptop-1366, hd-1920. Example: `apps/web/e2e/screenshots/hd-1920/present-leaderboard.png`
- Problem: The points-gained column is blank for 3rd (Kim) and 5th (Lee), while the other rows show '+940', '+870' and '+810'. The column has no visible header, so the gaps look like missing data rather than 'gained nothing this round'.
- Expected: Show '+0' or a dash for players who gained no points, or give the column a visible header.
- Verifier's diagnosis (check it; it can be wrong): apps/web/src/screens/present/Boards.tsx:84. `<td className={s.delta}>{e.delta > 0 ? `+${groupDigits(e.delta)}` : ''}</td>` renders an empty string when the delta is 0 (fixture: hostSnapshots.ts LEADERBOARD, Kim and Lee delta: 0).
- Suggested fix: Render an explicit zero: `{e.delta > 0 ? `+${groupDigits(e.delta)}` : '+0'}`, or '–' with a VisuallyHidden 'no points this round'. `.delta` already right-aligns with tabular numerals, so the column stays aligned.

### VC-05 (high) present-get-ready, present-question-open, present-question-image, present-question-long, present-reveal-single, present-reveal-truefalse, present-reveal-poll

- Projects: phone-320. Example: `apps/web/e2e/screenshots/phone-320/present-reveal-single.png`
- Problem: At 320 px the stage shrinks but the ink outlines on answer glyphs and chart bars stay a fixed pixel width, so the outline covers most of the colour. The B plus and C star glyphs render almost solid black, and only a speck of blue or green shows inside A and D. On reveal screens the bar for the correct answer, which gets the thicker outline, turns fully black: A Mercury's blue bar in reveal-single and B False's vermillion bar in reveal-truefalse. The Okabe-Ito colour cue from ADR-0016 disappears at this size.
- Expected: Outline width should scale with the stage (cqh units, or a clamp with a low minimum) so every glyph and bar keeps a visible fill at every stage size. The correct-answer outline should never cover the bar colour.
- Verifier's diagnosis (check it; it can be wrong): apps/web/src/screens/present/Present.module.css:9 `--outline-w: max(3px, calc(var(--u) * 0.45));` has a 3px floor that dominates whenever u < 6.7px. The same variable is used by the bar fill (Present.module.css:313), the correct fill (Present.module.css:325, `calc(var(--outline-w) * 2.2)`), and the glyph stroke (apps/web/src/ui/AnswerGlyph.module.css:9, non-scaling stroke).
- Suggested fix: Present.module.css:9: lower the floor so the outline scales with the stage, e.g. `--outline-w: max(1px, calc(var(--u) * 0.45));`. At 1366 and up the value is unchanged in practice (0.45u is already at least 3px from about 1200px stage width). Also cap the correct-answer border so it can never exceed the track, e.g. Present.module.css:325 `border-width: min(calc(var(--outline-w) * 2.2), calc(var(--u) * 1.2));`.

### VC-06 (medium) present-open

- Projects: phone-320. Example: `apps/web/e2e/screenshots/phone-320/present-open.png`
- Problem: The response cards overflow into the pagination row. The last line of 'Volunteer at the food bank for a morning.' ('morning.') is hidden behind the dashed 'Previous page' button. That button also overlaps the 'Page 1 of 2' label, whose text runs into the button border. The card grid is not constrained to the space left above the pager.
- Expected: The cards should fit within their grid area, or fewer cards per page should be shown when the stage is small. The pager row should never overlap card content, and its buttons and label should have clear spacing.
- Verifier's diagnosis (check it; it can be wrong): apps/web/src/screens/present/Present.module.css:393-394 `.pageButton { min-width/min-height: max(24px, calc(var(--u) * 5)) }` gives a px floor that the unit-based budget in apps/web/src/screens/present/Reveal.tsx:43 (`CONTENT_HEIGHT_U - headU - 4 - 7`) does not account for. The 3px outline floor on .card (Present.module.css:377 via line 9) adds more height than CARD_BORDER_U = 0.6 in layout.ts:327 allows.
- Suggested fix: Apply the outline-scaling fix from finding 0 (Present.module.css:9). Then let the pager's reserved height follow its real size: either drop the px floor (`min-height: calc(var(--u) * 5)` at Present.module.css:394), or keep the 24px target and let the card region shrink to what is left. For the second option, make ChartFrame/.cards `flex: 1 1 0; min-height: 0` with the pager as a `flex: none` sibling, and pass paginateCards the height remaining after the pager instead of the fixed 7u.

### VC-07 (low) present-help

- Projects: phone-320, tablet-768. Example: `apps/web/e2e/screenshots/phone-320/present-help.png`
- Problem: At 320 px the shortcuts dialog is taller than the 180 px stage and is clipped at the top. The 'Keyboard shortcuts' title and the Space / right-arrow row are cut off, and the 'Page Down' key and the 'question' text are cut in half. The footnote 'is safe.' is clipped behind the Close button, and Close has an oversized double focus ring. At 768 px the dialog fits, but Close's focus ring nearly touches the 'is safe.' line above it.
- Expected: The dialog should size to the viewport (for example max-height 100% with internal scroll), keep its title visible, and leave space between the footnote and the Close button.
- Verifier's diagnosis (check it; it can be wrong): apps/web/src/screens/present/HelpOverlay.module.css:69 `.close { margin-top: calc(var(--u) * 1.5); }` is smaller than focus-w + focus-offset (apps/web/src/ui/base.css:70-72, 4px + 3px).
- Suggested fix: HelpOverlay.module.css:69: `margin-top: max(calc(var(--u) * 1.5), calc(var(--focus-w) + var(--focus-offset) + 4px));`. Optionally also give the dialog `padding-bottom` of at least the ring size so the ring is not clipped by overflow:auto at the bottom.

### VC-08 (medium) present-lobby-400

- Projects: phone-320, tablet-768. Example: `apps/web/e2e/screenshots/phone-320/present-lobby-400.png`
- Problem: The '+336 more' overflow chip uses a fixed-width ink border that does not scale with the stage. At 320 px the border covers the label and the chip reads as a black bar with garbled white text. At 768 px the text touches the top and bottom of the border. The chip looks fine at 1366, 1920 and 3840.
- Expected: The chip's border and padding should scale with the stage, like the name chips, so '+336 more' stays legible at every stage size.
- Verifier's diagnosis (check it; it can be wrong): apps/web/src/screens/present/Present.module.css:611-614 `.more { border: var(--outline-w) solid var(--ink); }`, with --outline-w floored at 3px (Present.module.css:9), inside a box whose height is a fixed var(--row-h) (Present.module.css:593).
- Suggested fix: Apply the outline scaling from finding 0 (Present.module.css:9 `max(1px, calc(var(--u) * 0.45))`), or draw the chip's outline without taking row height, e.g. `.more { border: 0; box-shadow: inset 0 0 0 max(1px, calc(var(--u) * 0.3)) var(--ink); }`.

### VC-09 (medium) present-question-open, present-question-image, present-question-long

- Projects: phone-320. Example: `apps/web/e2e/screenshots/phone-320/present-question-image.png`
- Problem: At 320 px the countdown progress bar under the timer ('11', '14', '18') renders as a solid black pill. The fixed-width outline covers the white remaining-time track, so the bar no longer shows how much time is left. At 768 px and 4K the filled and empty parts are clearly visible.
- Expected: The bar's outline should scale with the stage so the filled and remaining parts stay visible.
- Verifier's diagnosis (check it; it can be wrong): apps/web/src/screens/present/Present.module.css:102-105 `.bar { height: calc(var(--u) * 2); border: var(--outline-w) solid var(--ink); }`, with --outline-w floored at 3px (Present.module.css:9).
- Suggested fix: Scale the outline (finding 0 fix at Present.module.css:9), or give .bar its own thinner border tied to its height, e.g. `border: max(1px, calc(var(--u) * 0.4)) solid var(--ink);` at line 105.

### VC-11 (low) all present-* screens (control bar)

- Projects: phone-320. Example: `apps/web/e2e/screenshots/phone-320/present-leaderboard.png`
- Problem: At 320 px the host control bar wraps to three rows. Its buttons have no gap between them (the borders of 'Start'/'Next' and 'Lock joining', and of 'Lock joining' and 'Text size 100%', touch), and the button text is about 3x larger than the stage text above it. The bar sits in the bottom letterbox far from the stage and looks unfinished compared with the single spaced row at 768 px and 4K.
- Expected: Keep a consistent gap between control buttons, and use a compact or overflow layout on narrow viewports so the controls do not dwarf the stage.
- Verifier's diagnosis (check it; it can be wrong): apps/web/src/screens/present/ControlBar.module.css:16 `gap: calc(var(--bu) * 0.8);` has no px floor, while the buttons themselves have px floors (lines 28-35).
- Suggested fix: ControlBar.module.css:16: `gap: max(6px, calc(var(--bu) * 0.8));` (and optionally `padding: max(4px, calc(var(--bu) * 0.6)) max(8px, calc(var(--bu) * 1.2));` at line 17).

### VC-12 (low) present-ended-unscored, present-podium

- Projects: uhd-3840, tablet-768, phone-320. Example: `apps/web/e2e/screenshots/uhd-3840/present-ended-unscored.png`
- Problem: The 'Thanks for taking part' end screen and the final-results podium still show 'Next' as the primary control, along with 'Lock joining'. The game is over, so it is unclear what Next does, and locking joining no longer applies.
- Expected: On ended states, replace 'Next' with a clear action (for example 'Finish' or 'Back to quizzes'), or hide it, and hide 'Lock joining'.
- Verifier's diagnosis (check it; it can be wrong): apps/web/src/dev/PresentFixture.tsx:60 hardcodes the next label instead of deriving it from the snapshot. apps/web/src/screens/present/ControlBar.tsx:48-50 renders the lock toggle unconditionally.
- Suggested fix: PresentFixture.tsx:60: derive the label as PresentPage does, e.g. `const next = nextAction(snapshot); nextLabel: next.command ? next.label : null` (import from state/commands.ts). Add a `canLock: boolean` prop to ControlBarProps, pass `canLock: snap?.phase !== 'ended'` from PresentPage.tsx:~203 (and the fixture), and wrap ControlBar.tsx:48-50 in `{p.canLock && ...}`.

### VC-60 (medium) present-reveal-single

- Projects: phone-390-dark. Example: `apps/web/e2e/screenshots/phone-390-dark/present-reveal-single.png`
- Problem: On the small letterboxed stage at phone width, the ink outlines on answer glyphs and bars are so thick that they hide the fills. In dark mode the hexagon, plus, star and dome show as white silhouettes with only a speck of colour. The correct answer's bar (A, Mercury) is solid white with no blue, because the doubled .correct .fill border (outline-w x 2.2) is taller than the bar. The same happens in the light phone capture, where bar A is solid ink. At 4K the same screen renders correctly: blue bar and coloured glyphs.
- Expected: Outline width should scale with the stage unit (or be capped at a fraction of the glyph or bar height), so fills stay visible at every stage size and the correct bar keeps its slot colour.
- Verifier's diagnosis (check it; it can be wrong): apps/web/src/screens/present/Present.module.css:9 (`--outline-w: max(3px, calc(var(--u) * 0.45))`: the 3 px floor does not scale down), Present.module.css:324-326 (`.correct .fill { border-width: calc(var(--outline-w) * 2.2) }` has no cap relative to the 5u track), and AnswerGlyph.module.css:9-11 (stroke-width var(--outline-w) with non-scaling stroke).
- Suggested fix: At Present.module.css:9, change the floor to `--outline-w: max(1px, calc(var(--u) * 0.45));`. Projector-sized stages (768 px tall and up, u of 6.9 px or more) still get 3 px or more, which satisfies ADR-0016. At Present.module.css:325, cap the correct border at a fraction of the track: `border-width: min(calc(var(--outline-w) * 2.2), calc(var(--u) * 1.4));`.

## Acceptance criteria

1. Every finding above is fixed as the lead's decisions say. If you conclude a finding is wrong, don't change code for it. Record it as a deviation with the evidence.
2. `pnpm --filter @zqhoot/web typecheck`, `pnpm --filter @zqhoot/web test` (includes the source scan) and `pnpm format:check` pass.
3. The gallery suite passes on all projects: `ZQ_E2E_PORT=4181 pnpm --filter @zqhoot/web test:e2e`. Other tasks run their own suites in parallel on other ports, so always set `ZQ_E2E_PORT=4181` for this task, for every Playwright run, including reviewers'. It takes about 9 minutes and covers axe, horizontal overflow and screenshots. Run it once at the end. While iterating, filter with `--grep <screen-id>` and `--project <name>`.
4. After the final run, open the regenerated screenshots in `apps/web/e2e/screenshots/<project>/<screen>.png` with the Read tool: every screen and project a finding names, plus the same screens at `phone-320`, `laptop-1366` and `uhd-3840`. Confirm each fix and check that nothing else on those screens got worse. List what you inspected in the report. Reviewers do the same.
5. No changes outside the files you own. No changes to `packages/*`, the servers, or the wire protocol.
6. Don't copy another product's look (hard requirement 6). Follow ADR-0016: colour is never the only cue, answers keep their letter and glyph, phones use rem, the presenter stage uses stage units.
