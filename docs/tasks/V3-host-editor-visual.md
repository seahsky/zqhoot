# V3-host-editor-visual: host, editor and fixture findings from the visual check

Owner: Sonnet implementation agent. Reviewer: independent Opus agent. Source: the lead's visual check of the gallery screenshots at every breakpoint (phase 5). Each finding below was confirmed by a second reviewer who opened the images. Their diagnosis of the cause is a lead, not a fact: read the code before relying on it.

## Read first

- `docs/adr/0016-visual-identity.md` (tokens, outlines, chart colours, forced colours)
- `apps/web/src/screens/host/*`, `apps/web/src/screens/edit/*`, `apps/web/src/ui/HostShell.*`, `ui/TextField.*`, `ui/StatusLine.*`, `ui/Controls.*`, `ui/base.css`, `ui/tokens.css`
- `apps/web/src/dev/HostFixtures.tsx` and `apps/web/src/dev/fixtures/{host,hostState,hostSnapshots,edit,questions,common}.ts`

## Files you own

`apps/web/src/screens/host/**`, `apps/web/src/screens/edit/**`, `apps/web/src/ui/HostShell.*`, `ui/TextField.*`, `ui/StatusLine.*`, `ui/Controls.*`, `ui/ConfirmDialog.*`, `ui/base.css`, `ui/tokens.css`, `apps/web/src/dev/HostFixtures.tsx`, `apps/web/src/dev/fixtures/{host,hostState,hostSnapshots,edit,questions,common}.ts`, and tests for these under `apps/web/test/`. `test/gallery-fixtures.test.ts` is shared with V2, so keep your edits to it small.

Other tasks are editing these files at the same time, so don't touch them: `apps/web/src/screens/present/**`, `screens/play/**`, `screens/join/**`, `ui/Button.*` (V2 owns the forced-colours button fix, which covers `ButtonLink` on host pages), `ui/Countdown.*`, `ui/AnswerGlyph.*`, `ui/Stage.*`, `dev/PresentFixture.tsx`, `dev/fixtures/{player,present}.ts`. `tokens.css` and `base.css` apply to every screen, so check the player and presenter screenshots after changing them.

## Lead's decisions

- **Fixtures (VC-01, VC-10, VC-38, VC-58, VC-69, VC-02).**
  - Generated nicknames read naturally ("Jo the Bold").
  - One game uses one player total across its fixture states. The `*_RESULT` snapshots use the same roster size as the lobby and question fixtures they belong to.
  - The dashboard's question count for a quiz matches the editor fixture of that quiz.
  - Question 3 has the same type across the host-live fixtures, or the fixtures use different question numbers. Keep 400-player fixtures where a screen exists to test 400 players.
- **Charts (VC-40, VC-57, VC-59).**
  - Host result bars use the answer's glyph colour with the ink outline, as the presenter chart does (ADR-0016).
  - In forced colours, bar fills stay visible and proportional, for example with `forced-color-adjust: none` and a system colour, or a pattern. The values also stay in text.
- **Editor structure (VC-35, VC-51, VC-50, VC-43, VC-54, VC-65).**
  - A collapsed question card with errors shows an error marker with text, not colour alone. Each item in the error summary opens and focuses the card it names.
  - Collapsed cards show a clear expand affordance (a chevron and an "Edit" label or similar) with `aria-expanded`.
  - Remove the unexplained blank bands. If a reserved empty message slot causes them, render the slot only when it has content, or give it no height.
  - Section headings such as "Answers" are visibly headings, stronger than field labels.
- **Answer rows (VC-36, VC-53, VC-64).** Each Remove button lines up with the input it removes. The character counter sits under the input without pushing the button down.
- **Image field (VC-37, VC-52).**
  - Replace the bare native file control with a label styled like the other buttons ("Choose image" / "Replace image"), with the native input visually hidden but keyboard-focusable and a visible focus ring.
  - Tap targets are at least 48 px on phones.
  - Never show "No file chosen" next to an existing image.
- **Selects and native controls (VC-55, VC-61, VC-66, VC-62).**
  - Question-type options use short names ("Multiple choice", "True or false", "Poll", "Word cloud", "Open-ended", "Rating"). The longer description appears as hint text for the selected type.
  - Form controls inherit the page font.
  - Radios and checkboxes are legible and clearly enabled in dark mode. Use `accent-color`, size, or custom styling with an ink outline.
- **Status indicators (VC-41, VC-56, VC-68).** "Unsaved changes" and the live status chips must not look like buttons: no button border and button shape. Use text with an icon or dot, still readable without colour.
- **Live control (VC-46, VC-47, VC-39).**
  - The join URL never breaks mid-word. Put it on its own line and allow breaks only after `/` or `.` if it still does not fit.
  - At 320 px, nicknames of up to 16 characters fit on one line in the roster. Rearrange the status and Kick controls if needed. An ellipsis is the last resort.
  - Align the Players and Control column headings and give them the same card treatment.
- **Other (VC-42, VC-44, VC-45, VC-49, VC-63).**
  - The editor column is centred in the shell, or uses the width, and question titles in the list are not squeezed into a narrow column.
  - Dates and times on dashboard cards don't break internally.
  - The sign-in header matches the other host pages.
  - The question textarea shows the whole prompt (grow with content, or enough rows for 200 characters at 320 px), and its font matches the other inputs unless ADR-0016 says otherwise.
  - Icons in host and editor UI are sized in em/rem, so they scale with text at 4K.
- **Declined (VC-48).** The roster's inner scroll area stays. It keeps a 400-player list usable next to the search box and the player count, and a row cut at the bottom edge is the usual cue that the list scrolls. Leave it as is.

## Findings

### VC-01 (low) present-lobby, present-lobby-400, present-help

- Projects: laptop-1366, hd-1920. Example: `apps/web/e2e/screenshots/hd-1920/present-lobby-400.png`
- Problem: Player names are glued together: 'Jothe Bold', 'Anathe Bold', 'Inesthe Bold2', 'Dmitrithe Bold2'. They read as misspellings on the projector. The cause is the fixture name generator: TAIL in apps/web/src/dev/fixtures/hostSnapshots.ts has 'the Bold' with no leading space (' K.' has one).
- Expected: Names read 'Jo the Bold', 'Ines the Bold2' and so on. Change the tail to ' the Bold' so the gallery shows realistic nicknames.
- Verifier's diagnosis (check it; it can be wrong): apps/web/src/dev/fixtures/hostSnapshots.ts:160, `const TAIL = ['', 'the Bold', '_99', 'Quizzer', ' K.', ...]`. The 'the Bold' entry has no leading space.
- Suggested fix: Change 'the Bold' to ' the Bold' in TAIL (hostSnapshots.ts:160). The longest result, 'Dmitri the Bold2', is 16 characters, so the `.slice(0, 16)` limit still holds. Optionally update the example string in test/present-layout.test.ts:32 to match.

### VC-10 (low) present-lobby, present-lobby-400, present-help

- Projects: uhd-3840, tablet-768, phone-320, present-lobby-400/1366x768, present-lobby-400/1920x1080, present-lobby-400/3840x2160. Example: `apps/web/e2e/screenshots/uhd-3840/present-lobby-400.png`
- Problem: Player names in the lobby read as broken strings: 'Jothe Bold', 'Anathe Bold', 'Inesthe Bold2', 'Faridthe Bold2' and so on. The fixture name generator in apps/web/src/dev/fixtures/hostSnapshots.ts concatenates first name and tail without a space (TAIL entry 'the Bold' has no leading space). The broken names show on every lobby screenshot and behind the help dialog.
- Expected: Fixture nicknames should read naturally, for example 'Jo the Bold', by giving the tail a leading space as ' K.' already has.
- Verifier's diagnosis (check it; it can be wrong): apps/web/src/dev/fixtures/hostSnapshots.ts:160 `const TAIL = ['', 'the Bold', ...]`.
- Suggested fix: hostSnapshots.ts:160: change 'the Bold' to ' the Bold'. Names are sliced to 16 chars at line 170, so 'Dmitri the Bold2' still fits exactly.

### VC-38 (low) host-live-lobby / host-live-question / host-live-reveal / host-live-moderation

- Projects: laptop-1366, hd-1920. Example: `apps/web/e2e/screenshots/laptop-1366/host-live-reveal.png`
- Problem: The player roster fixture produces broken nicknames with a missing space: 'Jothe Bold', 'Anathe Bold', 'Amarathe Bold', 'Yukithe Bold', 'Tomasthe Bold', 'Priyathe Bold', and so on. They read as typos at the top of the Players list on every live-control screen. (Cause: TAIL entry 'the Bold' in apps/web/src/dev/fixtures/hostSnapshots.ts has no leading space.)
- Expected: Nicknames like 'Jo the Bold', i.e. use ' the Bold' in the fixture tail list.
- Verifier's diagnosis (check it; it can be wrong): apps/web/src/dev/fixtures/hostSnapshots.ts:160 `const TAIL = ['', 'the Bold', ...]`, concatenated at line 170 as `${first}${tail}`.
- Suggested fix: hostSnapshots.ts:160 change 'the Bold' to ' the Bold' (the longest result, 'Amara the Bold'/'Dmitri the Bold', is ≤16 chars; the .slice(0,16) still applies). Regenerate the host-live-* and present-* screenshots.

### VC-58 (low) host-live-* (roster), host-dashboard vs edit-quiz, host-live-question vs host-live-moderation

- Projects: phone-320, phone-390, tablet-768. Example: `apps/web/e2e/screenshots/phone-390/host-live-reveal.png`
- Problem: Some fixture copy is wrong or inconsistent. Generated nicknames lack a space ('Jothe Bold', 'Amarathe Bold', 'Samthe Bold'; TAIL 'the Bold' in fixtures/hostSnapshots.ts). The dashboard says 'Friday night trivia' has 10 questions but the editor shows 6. 'Question 3 of 10' is multiple choice in host-live-question, open-ended in host-live-moderation, and a Poll in the editor.
- Expected: Change the TAIL entry to ' the Bold', and make the question counts and question 3 consistent across fixtures so the screenshots look like one real session.
- Verifier's diagnosis (check it; it can be wrong): apps/web/src/dev/fixtures/hostSnapshots.ts:160 (`'the Bold'` with no leading space); apps/web/src/dev/fixtures/host.ts:52 (`questionCount: 10` against the 6-question editor draft in fixtures/edit.ts); hostSnapshots.ts:203 (`totalQuestions: 10`).
- Suggested fix: hostSnapshots.ts:160: change `'the Bold'` to `' the Bold'`. host.ts:52: set `questionCount: 6` to match the editor draft, or add questions to the edit fixture. Optionally make the host-live snapshots use the same quiz (a total of 6, with question 3 matching the editor's type).

### VC-69 (low) host-live-lobby, host-live-question, host-live-reveal, host-live-moderation

- Projects: phone-390-dark, phone-390-forced-colors, uhd-3840. Example: `apps/web/e2e/screenshots/uhd-3840/host-live-reveal.png`
- Problem: Player nicknames in the fixture read 'Jothe Bold', 'Anathe Bold', 'Amarathe Bold', 'Tomasthe Bold' and so on. The TAIL entry 'the Bold' in apps/web/src/dev/fixtures/hostSnapshots.ts has no leading space, so the names look like typos in every host roster.
- Expected: Change the tail to ' the Bold' so the fixture shows 'Jo the Bold' and similar.
- Verifier's diagnosis (check it; it can be wrong): apps/web/src/dev/fixtures/hostSnapshots.ts:160, `const TAIL = ['', 'the Bold', ...]`.
- Suggested fix: Change it to `' the Bold'`. Also update the literal 'Amarathe Bold2' in apps/web/test/present-layout.test.ts:32 to 'Amara the Bold2' so the width test still uses a realistic fixture name.

### VC-02 (low) present-question-image, present-question-long, present-question-open vs present-reveal-*, present-wordcloud, present-open, present-rating

- Projects: laptop-1366, hd-1920. Example: `apps/web/e2e/screenshots/hd-1920/present-reveal-single.png`
- Problem: The answer count changes wording, position and colour between sibling screens. On question screens it reads '12 / 22 answered' at the top right in ink. On results screens it reads '30 of 32 answered' at the bottom left in ink-2. The fixture game also switches from 22 players (lobby, questions, ended screen) to 32 players on every results screen, so the totals don't match within one session.
- Expected: Use one format (for example '30 of 32 answered') and one position for the answer count on all presenter screens, and use a consistent player total across the fixture states of the same game.
- Verifier's diagnosis (check it; it can be wrong): apps/web/src/screens/present/Question.tsx:86 builds `${answered} / ${totalPlayers} answered`. apps/web/src/screens/present/Reveal.tsx:61-65 renders `{answered} of {totalPlayers} answered` in `.footer` (Present.module.css:333-341, colour var(--ink-2), 3.5u). The fixture totals come from apps/web/src/dev/fixtures/hostSnapshots.ts:260-344 (totalPlayers: 32), while present.ts uses roster(22) and roster(400).
- Suggested fix: Use one phrasing. For example, change Question.tsx:86 to `${groupDigits(view.answered)} of ${groupDigits(view.totalPlayers)} answered`, or make Reveal.tsx:63 use ' / '. Optionally, for a coherent gallery, set totalPlayers to 22 in the *_RESULT fixtures in hostSnapshots.ts, scaling answered and the counts to 22 or fewer.

### VC-35 (medium) edit-errors

- Projects: laptop-1366, hd-1920. Example: `apps/web/e2e/screenshots/laptop-1366/edit-errors.png`
- Problem: The error summary lists 'Question 2, answer C: write the answer text.' but question 2 (Poll, 'Where should we eat lunch?') is collapsed, and its row has no error marker, badge or outline. Its row looks exactly like a valid one. Question 3 only gets away with it because its fallback title reads 'No question text yet'. A host scanning the question list cannot tell which collapsed questions need fixing.
- Expected: Each collapsed question row that contains errors should show a visible marker, such as a warning glyph plus text like '1 problem' or a heavier/dashed outline, so errors can be found from the list as well as from the summary links.
- Verifier's diagnosis (check it; it can be wrong): apps/web/src/screens/edit/QuestionCard.tsx:245-259: the card head renders only the number, the type and summaryText(q), with no per-question issue count. apps/web/src/screens/edit/EditorScreen.tsx:259-285: QuestionCard is never passed the issues that belong to question i, although FieldIssue.question exists (state/editor.ts:306).
- Suggested fix: In EditorScreen.tsx:259 pass `problems={p.issues.filter((x) => x.question === i).length}` and add `problems: number` to QuestionCardProps. In QuestionCard.tsx inside .summaryText (after line 257), render `{p.problems > 0 && <span className={styles.problemTag}><svg …warning triangle as in TextField…/> {p.problems === 1 ? '1 problem' : `${p.problems} problems`}</span>}`, and add `data-invalid` on the <li> so Editor.module.css can give `.card[data-invalid]` a thicker border (e.g. `border-width: calc(var(--outline-w) * 2)`). Add `.problemTag { display:flex; gap:.375rem; align-items:center; font-size:var(--fs-small); font-weight:800 }`.

### VC-36 (medium) edit-question-single / edit-question-poll / edit-errors

- Projects: laptop-1366, hd-1920. Example: `apps/web/e2e/screenshots/laptop-1366/edit-question-single.png`
- Problem: In the Answers list, each 'Remove' button is not aligned with its text input. It sits about 20-25px lower, lined up with the '6 / 80' counter row under the input. Every answer row looks stepped, and each Remove button sits almost on the next answer's label ('Answer B', 'Answer C'), which makes it unclear which answer it removes.
- Expected: Vertically centre or top-align the Remove button with the input box (put the counter below both), so each answer row reads as one unit.
- Verifier's diagnosis (check it; it can be wrong): apps/web/src/screens/edit/Editor.module.css:186-191: `.optionRow { align-items: flex-end }` aligns the button to the bottom of .optionField, whose TextField frame includes the counter/meta row under the input (ui/TextField.tsx:70-89).
- Suggested fix: Editor.module.css:189 change to `align-items: flex-start;` and add `.optionRow > button { margin-top: calc(1.125rem * 1.4 + 0.5rem + 0.375rem); }` (label line height + field gap + (3.5rem input − 2.75rem compact button)/2) so the button centres on the input box and the counter stays below the input.

### VC-37 (medium) edit-question-single

- Projects: laptop-1366, hd-1920. Example: `apps/web/e2e/screenshots/hd-1920/edit-question-single.png`
- Problem: The image field shows the uploaded Saturn picture and a 'Remove image' button, but right next to them the unstyled native file input says 'Choose File No file chosen'. That contradicts the visible image. The native control is also tiny, grey and system-styled, unlike every other button on the page (rounded, 2px ink outline, bold). The same unstyled 'Choose File' control appears in every expanded question editor.
- Expected: Hide the native input behind a styled button in the app's style ('Choose image' / 'Replace image'), and don't show 'No file chosen' when an image is already attached.
- Verifier's diagnosis (check it; it can be wrong): apps/web/src/screens/edit/ImageField.tsx:54-68 renders a visible native `<input type="file">`, styled only with `.file { max-width:100%; font-size:1rem }` (Editor.module.css:213-216).
- Suggested fix: Visually hide the input (e.g. Editor.module.css .file → `position:absolute; width:1px; height:1px; opacity:0; overflow:hidden;`, keeping it focusable and labelled) and add before 'Remove image' in ImageField.tsx:69: `<Button size="compact" variant="secondary" disabled={uploading} onClick={() => input.current?.click()}>{imageKey ? 'Replace image' : 'Choose image'}</Button>`. The `<label htmlFor>` stays, so getByLabel('Image (optional)').setInputFiles in e2e keeps working.

### VC-39 (low) host-live-lobby / host-live-question / host-live-reveal / host-live-moderation

- Projects: laptop-1366, hd-1920. Example: `apps/web/e2e/screenshots/laptop-1366/host-live-question.png`
- Problem: The two columns' headings don't line up. 'Players' (right) sits outside a box at y≈339, while 'Control' (left) sits inside a bordered card at y≈362. The Players column also stacks a count, 'Find a player' label, search box and a separately bordered list, while the left column uses cards. The two columns look like different components.
- Expected: Align the headings on one baseline: either put Players in a card like Control, or take the Control heading out of its card.
- Verifier's diagnosis (check it; it can be wrong): apps/web/src/screens/host/LiveScreen.tsx:210 the Players `<section className={styles.side}>` has no panel frame, while the Control section uses `styles.panel` (LiveScreen.tsx:81; Host.module.css:167-175 adds 1.25rem padding + outline).
- Suggested fix: LiveScreen.tsx:210 give the side section the panel frame, e.g. `className={cx(styles.side, styles.panel)}` (import cx from '../../ui/cx.ts'), so both headings sit 1.25rem + outline inside a card at the same y.

### VC-40 (low) host-live-question / host-live-reveal

- Projects: laptop-1366, hd-1920. Example: `apps/web/e2e/screenshots/hd-1920/host-live-question.png`
- Problem: The result bars in the live-control chart are plain ink (black) fills in thin outlined tracks, while the answer glyphs beside them are Okabe-Ito coloured. ADR-0016 says colour belongs on glyphs and chart bars, so the host chart does not match the identity (and probably the presenter chart). The screenshots for question-open and results-shown are also visually almost identical, apart from the chip text and button label.
- Expected: Fill each bar with its answer's colour and ink outline, as ADR-0016 describes, so host and presenter charts match.
- Verifier's diagnosis (check it; it can be wrong): apps/web/src/screens/host/Host.module.css:239-243 `.barFill { background: var(--ink); }`, and Distribution.tsx:55 passes only the width.
- Suggested fix: Distribution.tsx:55 set `style={{ width: `${r.percent}%`, background: `var(${SLOTS[r.slot]?.token ?? '--ink'})` }}` (import SLOTS from '../../ui/slots.ts') and add `border-right: var(--outline-w) solid var(--ink);` to .barFill (the track already provides the outer ink outline), matching the presenter bars.

### VC-41 (low) edit-conflict

- Projects: laptop-1366, hd-1920. Example: `apps/web/e2e/screenshots/laptop-1366/edit-conflict.png`
- Problem: The 'Unsaved changes' status pill next to 'Save quiz' has the same rounded 2px-outline, bold style as the outline buttons ('Reload the latest version', 'Move down'), so it looks clickable. The live-control status chips ('Waiting to start', 'Question open', '22 players') have the same button-like styling.
- Expected: Style status indicators differently from buttons: no outline or a dotted one, lighter weight, a leading dot or icon, so they don't read as controls.
- Verifier's diagnosis (check it; it can be wrong): apps/web/src/ui/StatusLine.module.css:7-12 (`.status:not(:empty)` gets `border: var(--outline-w) solid var(--ink); border-radius: var(--radius); background: var(--surface)`); likewise Host.module.css:125-131 `.chip`.
- Suggested fix: StatusLine.module.css:9 replace the solid outline with no border or `border: 2px dotted var(--ink-2)`, and add a leading marker, e.g. `.status:not(:empty)::before { content: '●'; margin-right: .375rem; }` with `font-weight: 600`. Optionally give Host.module.css .chip `border-style: dotted` or `border: 0; background: var(--surface)` so status never mimics a button.

### VC-42 (low) edit-quiz / edit-question-* / edit-errors / edit-conflict

- Projects: laptop-1366, hd-1920. Example: `apps/web/e2e/screenshots/hd-1920/edit-quiz.png`
- Problem: The editor column is capped at 52rem and left-aligned inside the wider shell. The header rule runs to x≈1552 at 1920 and x≈1275 at 1366, but all content stops at about x≈1200/922, leaving a blank strip on the right about 350px wide. Meanwhile, question titles in the list rows are squeezed into a ~230px column and wrap to 4 lines ('How likely are you to / recommend this / workshop to a / colleague?') because the four action buttons take most of the row.
- Expected: Either centre the editor column or use the spare width (for example, let question rows grow or move the row actions into a compact menu) so titles get room and the page doesn't look unfinished on desktop.
- Verifier's diagnosis (check it; it can be wrong): apps/web/src/screens/edit/Editor.module.css:7 `.page { max-width: 52rem }` inside a 76rem shell (ui/HostShell.module.css:5), combined with Editor.module.css:109 `.summaryButton { flex: 1 1 16rem }` and non-shrinking .cardActions (152-156).
- Suggested fix: Give the question list the spare width: e.g. Editor.module.css:7 raise to `max-width: 64rem` (or remove it and cap only form fields with `.section > * { max-width: 52rem }`). Alternatively make the title take priority with `.summaryButton { flex: 1 1 24rem }` so the action group wraps under the title when there isn't room.

### VC-43 (low) edit-question-single / truefalse / poll / wordcloud / open / rating

- Projects: laptop-1366, hd-1920. Example: `apps/web/e2e/screenshots/laptop-1366/edit-question-poll.png`
- Problem: Every expanded question editor has an unexplained ~50-60px gap after the image/file field (before 'Answers', 'Correct answer', 'Words per player', 'Scale', 'Responses per player'), then a second gap between the 'Answers' heading and 'Answer A'. The 'Answers' heading is also the same small size as the field labels, so the section hierarchy is flat. The answer/choice radios and inputs show only letters, with no hexagon/plus/star/dome glyphs, so the editor never shows the A-F legend that ADR-0016 wants on first use.
- Expected: Use consistent vertical rhythm between fields, a real section heading for Answers, and the answer glyph beside each Answer A-F input and correct-answer radio.
- Verifier's diagnosis (check it; it can be wrong): (1) apps/web/src/ui/base.css:23-28 resets margins only on h1-h3 and p, so `<h4 className={styles.h4}>Answers</h4>` (QuestionCard.tsx:62) keeps the UA 1.33em top/bottom margins inside a flex column. (2) Editor.module.css:206-207 `.status { min-height: 1.25rem }` reserves an empty line under the file input (ImageField.tsx:75-77) on top of the field gap. (3) Editor.module.css:39-41 `.h4 { font-size: 1.125rem }` equals the label size (TextField.module.css:7-10).
- Suggested fix: Add `h4` to the margin reset in base.css:23-26 (`h1, h2, h3, h4, p { margin: 0; }`). Drop `min-height: 1.25rem` from Editor.module.css:207 (or hide the empty status with `.status:empty { min-height: 0 }`). Make `.h4 { font-size: 1.25rem; font-weight: 800; }` in Editor.module.css:39. Optionally render `<AnswerGlyph slot={j} size={22} />` before each 'Answer X' label and correct-answer radio label (QuestionCard.tsx:76, 140).

### VC-44 (low) host-dashboard

- Projects: laptop-1366, hd-1920. Example: `apps/web/e2e/screenshots/laptop-1366/host-dashboard.png`
- Problem: In the 'Friday night trivia' recent-session card, the meta line 'PIN 482 915 · Question open · started 15 Jan, 07:00' breaks mid-date, leaving 'Jan, 07:00' orphaned on its own line. The sibling card fits on one line, so the two cards' button rows sit at different heights relative to their text.
- Expected: Keep the date together (non-breaking spaces) or put the status on its own line, so the meta line wraps cleanly.
- Verifier's diagnosis (check it; it can be wrong): apps/web/src/screens/host/format.ts:11-13 formatWhen returns '15 Jan, 07:00' with ordinary spaces, and DashboardScreen.tsx:95 inlines it into a wrapping meta line.
- Suggested fix: format.ts:12 `return WHEN.format(new Date(epochMs)).replace(/ /g, ' ');` (or wrap the date in DashboardScreen.tsx:95/45 in `<span style={{ whiteSpace: 'nowrap' }}>`), so the date moves to the next line as a unit.

### VC-45 (low) host-login

- Projects: laptop-1366, hd-1920. Example: `apps/web/e2e/screenshots/hd-1920/host-login.png`
- Problem: The sign-in header is shorter than on every other host page: the wordmark sits at y≈30 and the rule at y≈57, versus y≈37 and y≈73 on the dashboard. The page title then starts right under the rule with less top space than 'Your quizzes' or 'Live session' get. Going from login to the dashboard makes the header jump.
- Expected: Use the same header height and title spacing as the signed-in host pages.
- Verifier's diagnosis (check it; it can be wrong): apps/web/src/ui/HostShell.module.css:24-30 `.brand` has `line-height: 1` (28px tall), and on the sign-in page (HostShell.tsx:32-49, onSignOut undefined) nothing else sets the header height, unlike .navLink/compact Button at min-height 2.75rem (HostShell.module.css:41; Button.module.css:44).
- Suggested fix: HostShell.module.css:24 give the brand the same box as the other header items: `.brand { display: inline-flex; align-items: center; min-height: 2.75rem; }` (or `.header { min-height: calc(2.75rem + 0.75rem) }`), so the rule sits at the same y on every host page.

### VC-46 (medium) host-live-lobby, host-live-question, host-live-reveal, host-live-moderation

- Projects: phone-320. Example: `apps/web/e2e/screenshots/phone-320/host-live-lobby.png`
- Problem: The join line breaks the URL mid-word: 'Players join at https://quiz.example.test/joi' then 'n with PIN 482 915' on the next line. A host reading this aloud or pointing players to it sees 'joi n', which is wrong.
- Expected: Keep the URL whole: put it on its own line in a smaller or monospace style, break only at '/' (for example with <wbr> or overflow-wrap:anywhere limited to the URL span), or show only the host part next to a large PIN.
- Verifier's diagnosis (check it; it can be wrong): apps/web/src/screens/host/Host.module.css:133-137. `.join` has `overflow-wrap: anywhere`, so the long URL in apps/web/src/screens/host/LiveScreen.tsx:63 (`<strong>{joinUrl}</strong>`) can break at any character. At 1.125rem bold the URL is wider than the 288px column.
- Suggested fix: In Host.module.css:136 change `.join` to `overflow-wrap: break-word`. In LiveScreen.tsx:63 render the URL with break opportunities after slashes, e.g. `<strong className={styles.joinUrl}>{joinUrl.split(/(?<=\/)/).map((part, i) => <Fragment key={i}>{part}<wbr /></Fragment>)}</strong>`. At 320 the line then breaks as '…example.test/' then 'join'. Optionally make `.joinUrl { display: block; }` so the URL gets its own line.

### VC-47 (medium) host-live-lobby, host-live-question, host-live-reveal, host-live-moderation (Players list)

- Projects: phone-320. Example: `apps/web/e2e/screenshots/phone-320/host-live-reveal.png`
- Problem: In the player roster the name column is squeezed by a fixed-width 'connected' column and the Kick button, so nicknames wrap mid-word: 'Amarath / e Bold', 'Tomasth / e Bold', 'Mateoth / e Bold'. Every row takes two lines and the names are hard to read.
- Expected: Give the name column the flexible space and let the status shrink (a dot plus a short label, or put the status under the name). Wrap names only at spaces, or truncate with an ellipsis; never break inside a word.
- Verifier's diagnosis (check it; it can be wrong): apps/web/src/screens/host/Host.module.css:338-343. `.rosterName { flex: 1; min-width: 0; overflow-wrap: anywhere }`: `flex: 1` sets the flex-basis to 0, so the name only gets the space left after the non-shrinking 'connected' label and the Kick button, and `anywhere` lets it break inside a word. The status span in apps/web/src/screens/host/Roster.tsx:62 reuses `.meta`, which also has `overflow-wrap: anywhere`.
- Suggested fix: Host.module.css:338: `.rosterName { flex: 1 1 auto; min-width: 0; font-weight: 700; overflow-wrap: break-word; }`. Add `.rosterStatus { flex: none; white-space: nowrap; }` and use `className={cx(styles.meta, styles.rosterStatus)}` at Roster.tsx:62. The name then wraps only at spaces, and falls back to breaking inside a word only when a single word is wider than the row.

### VC-48 (low) host-live-lobby, host-live-question, host-live-reveal, host-live-moderation (Players list)

- Projects: phone-320, phone-390, tablet-768. Example: `apps/web/e2e/screenshots/phone-320/host-live-reveal.png`
- Problem: The roster is a fixed-height inner scroll box that cuts through a row at its bottom edge. At 320 the last row's 'Samthe Bold' text and Kick button are sliced by the border; at 390 and 768 only the top of the next Kick button shows. On a phone this puts a nested scroll area inside a scrolling page, and nothing says 15 more players are hidden. The 2 disconnected players in the lobby ('22 players, 20 connected') are also out of view.
- Expected: Size the box to whole rows, or add a fade or 'Showing 7 of 22' hint. On phones consider letting the list flow in the page, or paginate it. Sort disconnected players first, or give them a clear marker, so the host can see them.
- Verifier's diagnosis (check it; it can be wrong): apps/web/src/screens/host/Host.module.css:317-323 (`.rosterScroll { max-height: 26rem; overflow: auto; … }`). apps/web/src/screens/host/Roster.tsx:22 sorts only by join order (`[...roster].reverse()`), so offline players are not brought to the top.
- Suggested fix: Host.module.css:317: apply the height cap only on wide layouts, e.g. move `max-height: 26rem; overflow: auto;` into `@media (min-width: 64rem) { .rosterScroll { … } }` so phones scroll the list with the page. Roster.tsx:22: `const all = [...roster].reverse().sort((a, b) => Number(a.connected) - Number(b.connected));` to list offline players first.

### VC-49 (low) edit-question-truefalse (question textarea)

- Projects: phone-320. Example: `apps/web/e2e/screenshots/phone-320/edit-question-truefalse.png`
- Problem: The Question textarea uses a much larger font than the other inputs and has a fixed height of about 4 lines. At 320 the 69-character prompt is cut off after 'with the naked', and the final word 'eye.' is hidden with no scroll cue.
- Expected: Auto-grow the textarea to fit its content (field-sizing: content, or JS), or use the same 16-18px input font as the other fields so a 200-character prompt fits or visibly scrolls.
- Verifier's diagnosis (check it; it can be wrong): apps/web/src/ui/TextField.module.css:48-51 (`.area { min-height: 8rem; resize: vertical; }`) together with `rows={3}` at apps/web/src/screens/edit/QuestionCard.tsx:310. The box has a fixed height and does not grow with its content.
- Suggested fix: TextField.module.css:48: `.area { min-height: 8rem; field-sizing: content; resize: vertical; }`. This auto-grows in Chromium and falls back to the current behaviour elsewhere. Optionally also raise `rows={3}` to `rows={5}` at QuestionCard.tsx:310 so a full-length prompt fits at 320 in browsers without field-sizing.

### VC-50 (medium) edit-* (collapsed question cards)

- Projects: phone-320, phone-390, tablet-768. Example: `apps/web/e2e/screenshots/tablet-768/edit-quiz.png`
- Problem: The only way to open a question is to click its summary (number, type, text), but a collapsed card shows no expand cue: no chevron, no 'Edit' button, no hover or underline styling. The open card's header looks the same as the closed ones. In edit-quiz every card is closed, and nothing tells a host how to edit a question.
- Expected: Add a visible disclosure cue to the summary button, such as a chevron that rotates when open or an 'Edit' / 'Close' label, and style the open card's header differently.
- Verifier's diagnosis (check it; it can be wrong): apps/web/src/screens/edit/QuestionCard.tsx:247-259. The summary `<button>` holds only the number and text spans. apps/web/src/screens/edit/Editor.module.css:107-120 (`.summaryButton`) removes the border and background and adds no disclosure styling.
- Suggested fix: QuestionCard.tsx:258: after `.summaryText`, add `<span className={styles.disclosure} aria-hidden="true">{p.open ? 'Close' : 'Edit'} <svg …chevron…/></span>`. Editor.module.css: `.summaryText { flex: 1; }`, `.disclosure { margin-left: auto; display: inline-flex; gap: .25rem; font-weight: 700; text-decoration: underline; }`, `.summaryButton[aria-expanded='true'] .disclosure svg { transform: rotate(180deg); }`, and `.summaryButton:hover .preview { text-decoration: underline; }`.

### VC-51 (medium) edit-errors

- Projects: phone-320, phone-390, tablet-768. Example: `apps/web/e2e/screenshots/tablet-768/edit-errors.png`
- Problem: The error summary lists 'Question 2, answer C: write the answer text.' and 'Question 3: write the question.', but cards 2 (Poll) and 3 (Rating) are collapsed and carry no error marker. Card 3 only says 'No question text yet' in normal ink, and card 2 looks valid, so the host cannot see from the list which questions need attention.
- Expected: Mark collapsed cards that have errors with a warning glyph and text such as '1 problem', and/or expand them automatically when validation fails.
- Verifier's diagnosis (check it; it can be wrong): apps/web/src/screens/edit/QuestionCard.tsx:247-259. The collapsed summary renders only the number, type and prompt, and QuestionCardProps (line 24) has no error count. EditorScreen.tsx:258-285 passes `errorOf` but no per-question count.
- Suggested fix: In EditorScreen.tsx (around line 259) pass `errorCount={p.issues.filter((iss) => fieldIdOf(iss).startsWith(`f-questions-${i}-`)).length}`, using the same id key that `issuesByField` uses. In QuestionCard.tsx:256 render `{p.errorCount > 0 && <span className={styles.cardError}><svg …warning triangle as in TextField…/> {p.errorCount === 1 ? '1 problem' : `${p.errorCount} problems`}</span>}` inside `.summaryText`. Style `.cardError` bold ink, and give the card `.card[data-invalid] { border-width: calc(var(--outline-w)*1.5) }`.

### VC-52 (medium) edit-question-* (Image field)

- Projects: phone-320, phone-390, tablet-768. Example: `apps/web/e2e/screenshots/phone-320/edit-question-poll.png`
- Problem: The image picker is the browser's unstyled 'Choose File No file chosen' control. It is about 22-24 CSS px tall, well below the 48px minimum on phones, and it clashes with the ink-outlined rounded buttons everywhere else, including 'Remove image' beside it.
- Expected: Hide the native input visually and use a styled label button ('Choose image', at least 48px tall), matching the secondary Button style, with the chosen file name shown as text.
- Verifier's diagnosis (check it; it can be wrong): apps/web/src/screens/edit/ImageField.tsx:54-68 renders a bare `<input type="file">` styled only by apps/web/src/screens/edit/Editor.module.css:213-216 (`.file { max-width: 100%; font-size: 1rem; }`).
- Suggested fix: Editor.module.css:213: `.file { position: absolute; width: 1px; height: 1px; opacity: 0; }` plus `.file:focus-visible + .fileButton { outline: 4px solid var(--ink); outline-offset: 3px; }`. In ImageField.tsx after the input, add `<label htmlFor={`${uid}-file`} className={cx(buttonStyles.button, buttonStyles.secondary, buttonStyles.compact, styles.fileButton)}>{imageKey ? 'Replace image' : 'Choose image'}</label>`. Keep the existing outer label as the field label. Show the file name or status as text in the existing `.status` paragraph.

### VC-53 (low) edit-question-single, edit-question-poll, edit-errors (answer rows)

- Projects: tablet-768. Example: `apps/web/e2e/screenshots/tablet-768/edit-question-single.png`
- Problem: At tablet width each 'Remove' button sits to the right of its answer input but is aligned with the '6 / 80' counter row, not the input. It hangs about half a row lower than the field it belongs to. 'Remove image' also floats mid-row, far from the file control and the preview.
- Expected: Align Remove with the input box (put the input and button in one flex row and the counter below both), and place 'Remove image' next to the preview or the file button.
- Verifier's diagnosis (check it; it can be wrong): apps/web/src/screens/edit/Editor.module.css:186-191 (`.optionRow { … align-items: flex-end; }`). The option field block is label + input + counter, so bottom alignment lines the button up with the counter.
- Suggested fix: Editor.module.css:189: change `align-items: flex-end;` to `align-items: center;`. The field's centre (label ~25px + gap + 56px input + gap + counter ~20px) falls within a few px of the input's centre, so the button lines up with the input. Wrapped phone layouts are unaffected.

### VC-54 (low) edit-question-single, -truefalse, -poll, -wordcloud, -open, -rating, edit-errors

- Projects: phone-320, phone-390, tablet-768. Example: `apps/web/e2e/screenshots/tablet-768/edit-question-poll.png`
- Problem: Below the Image field there is an empty band of about 50-70 CSS px, then an 'Answers' heading, then another large gap before 'Answer A'. The gaps are much bigger than the spacing between other fields and look like a missing element, probably an empty reserved message slot.
- Expected: Collapse the empty slot when there is no message, and use the same vertical rhythm as the other fields.
- Verifier's diagnosis (check it; it can be wrong): (1) apps/web/src/screens/edit/Editor.module.css:206-207: `.status { min-height: 1.25rem; … }` on the always-mounted `<p role="status">` at ImageField.tsx:75, which adds 1.25rem plus the 0.5rem field gap even when empty. (2) apps/web/src/ui/base.css:23-27 resets margins on h1-h3 and p but not h4, so `<h4 className={styles.h4}>Answers</h4>` (QuestionCard.tsx:62, styled at Editor.module.css:39-41) keeps the default 1.33em top and bottom margins, about 24px each, on top of the flex gaps.
- Suggested fix: base.css:23: add `h4` to the margin reset list (`h1, h2, h3, h4, p { margin: 0; }`), or add `margin: 0;` to `.h4` at Editor.module.css:39. Editor.module.css:207: remove `min-height: 1.25rem` from `.status`. The live region stays mounted but takes no space while empty, so the gaps return to the 1.25rem body rhythm.

### VC-55 (low) edit-* (New question type select)

- Projects: phone-320, phone-390. Example: `apps/web/e2e/screenshots/phone-320/edit-quiz.png`
- Problem: The 'New question type' select shows long option text that is clipped by the arrow: 'Multiple choice: 2 to 4 answe…' at 320 and '…answers, one is' at 390. The meaning is lost. The Poll answer input also shows 'The deli on the cor' at 320.
- Expected: Use short option labels in the select ('Multiple choice', 'True or false', 'Poll', …) and put the description in hint text below it.
- Verifier's diagnosis (check it; it can be wrong): apps/web/src/screens/edit/EditorScreen.tsx:292-295: `label: `${t.label}: ${t.hint}`` for every option of the 'New question type' SelectField.
- Suggested fix: EditorScreen.tsx:294: use `label: t.label`, and pass `hint={QUESTION_TYPES.find((t) => t.type === newType)?.hint}` to the SelectField at line 289 so the description appears as hint text below the label.

### VC-56 (low) edit-conflict

- Projects: phone-320, phone-390, tablet-768. Example: `apps/web/e2e/screenshots/tablet-768/edit-conflict.png`
- Problem: The 'Unsaved changes' status indicator is drawn as an outlined rounded rectangle with the same border weight and shape as the secondary buttons beside 'Save quiz', so it looks clickable. The host status chips ('Question open') use a clearly pill-shaped style.
- Expected: Use the same chip or pill style as the host status chips (fully rounded, smaller, no button padding), or plain text with an icon.
- Verifier's diagnosis (check it; it can be wrong): apps/web/src/ui/StatusLine.module.css:7-12 (`.status:not(:empty) { padding: .5rem .75rem; border: var(--outline-w) solid var(--ink); border-radius: var(--radius); background: var(--surface); }`), used for the editor's save status at apps/web/src/screens/edit/EditorScreen.tsx:165 with `styles.saveStatus` (Editor.module.css:25), which only hides it when empty.
- Suggested fix: Override locally in Editor.module.css after line 27: `.saveStatus:not(:empty) { padding: .25rem .75rem; border-radius: 999px; background: transparent; }`, matching `.chip` in Host.module.css:125-131. Or drop the border (`border: 0; padding: 0;`) and prefix a small status glyph.

### VC-57 (low) host-live-question, host-live-reveal

- Projects: phone-320, phone-390, tablet-768. Example: `apps/web/e2e/screenshots/tablet-768/host-live-reveal.png`
- Problem: The result bars are filled with plain ink for every option. Only the small glyph carries the answer colour, although ADR-0016 says fills colour the glyphs and the chart bars. This is inconsistent with the chart rules in the visual identity.
- Expected: Fill each bar with its slot colour and an ink outline, keeping the letter, glyph and 'Correct answer' text badge.
- Verifier's diagnosis (check it; it can be wrong): apps/web/src/screens/host/Host.module.css:239-243 (`.barFill { background: var(--ink); }`) and apps/web/src/screens/host/Distribution.tsx:55, which sets only the width.
- Suggested fix: Distribution.tsx:55: `style={{ width: `${r.percent}%`, ['--fill-color' as string]: `var(${SLOTS[r.slot]?.token ?? '--ink'})` }}`, importing SLOTS from '../../ui/slots.ts'. Host.module.css:242: `background: var(--fill-color, var(--ink)); border-right: var(--outline-w) solid var(--ink);`. The track already has the ink outline.

### VC-59 (high) host-live-question, host-live-reveal

- Projects: phone-390-forced-colors. Example: `apps/web/e2e/screenshots/phone-390-forced-colors/host-live-question.png`
- Problem: In forced colours, every result bar in the 'Now: Multiple choice' card is an empty outlined pill. The .barFill background (var(--ink)) in Host.module.css is dropped and Host.module.css has no forced-colors rule, so A at 50% and D at 7% draw identical empty tracks. The chart looks like nobody answered, and only the '7 · 50%' text still carries the data.
- Expected: Bars keep their length in forced colours. Add an @media (forced-colors: active) rule for .barFill with forced-color-adjust: none and background: CanvasText, or draw the fill as a border, as Present.module.css already does for its bars.
- Verifier's diagnosis (check it; it can be wrong): apps/web/src/screens/host/Host.module.css:239-243 draws .barFill with only `background: var(--ink)`, which forced colours override to Canvas. Host.module.css has no @media (forced-colors: active) rule. Present.module.css:123-128 already handles its own bars.
- Suggested fix: Append to Host.module.css: `@media (forced-colors: active) { .barFill { forced-color-adjust: none; background: CanvasText; } }`. This also covers the rating list, which reuses .barFill.

### VC-61 (low) edit-quiz, edit-question-*, edit-errors, edit-conflict

- Projects: phone-390-dark, phone-390-forced-colors. Example: `apps/web/e2e/screenshots/phone-390-dark/edit-quiz.png`
- Problem: The 'New question type' select at the bottom of every editor screen cuts its label off mid-sentence, with no ellipsis: 'Multiple choice: 2 to 4 answers, one is'. It reads as broken copy. At 4K the full 'Multiple choice: 2 to 4 answers, one is correct' fits.
- Expected: Use a short option label that fits at 390 px (e.g. 'Multiple choice') and move the explanation into help text. Alternatively, apply text-overflow: ellipsis.
- Verifier's diagnosis (check it; it can be wrong): apps/web/src/screens/edit/EditorScreen.tsx:292-294 builds the option label as `${t.label}: ${t.hint}` (hints from apps/web/src/state/editor.ts:24 and following). The select is width:100% (apps/web/src/ui/Controls.module.css:1-2), so at 390 px the label overflows.
- Suggested fix: At EditorScreen.tsx:293, use `label: t.label` only, and pass the explanation of the selected type through SelectField's existing `hint` prop, e.g. `hint={QUESTION_TYPES.find((t) => t.type === newType)?.hint}`.

### VC-62 (low) edit-question-single, edit-question-truefalse, edit-errors (and file inputs on all edit-question-*)

- Projects: phone-390-dark. Example: `apps/web/e2e/screenshots/phone-390-dark/edit-question-single.png`
- Problem: Native controls are left unstyled in dark mode. Unchecked radios ('B · Jupiter', 'True') and the unchecked 'Streak bonus' checkbox are dark-grey (#3B3B3B) blobs with a thin 1 px grey ring on #0B1020, next to 3 px white-outlined text fields. The 'Choose File' button is a flat mid-grey native button. These controls look disabled and don't match the rest of the form.
- Expected: Style radios, checkboxes and the file-input button with the same ink outline and token colours as the other inputs, e.g. with accent-color plus a custom border, or with appearance: none.
- Verifier's diagnosis (check it; it can be wrong): apps/web/src/ui/Controls.module.css:24-31 sets only `accent-color: var(--ink)` on .checkbox and .radio, which leaves the unchecked state to the UA's dark theme. apps/web/src/screens/edit/Editor.module.css:213-216 (.file) does not style ::file-selector-button.
- Suggested fix: In Controls.module.css .checkbox and .radio, add `appearance: none; border: var(--outline-w) solid var(--ink); background: var(--bg);` plus `border-radius: 999px` for .radio and `4px` for .checkbox. Draw the checked state with `:checked { background: var(--ink); box-shadow: inset 0 0 0 3px var(--bg); }`. In Editor.module.css add `.file::file-selector-button { font: inherit; padding: 0.5rem 1rem; border: var(--outline-w) solid var(--ink); border-radius: var(--radius); background: var(--bg); color: var(--ink); }`.

### VC-63 (low) host-live-question, host-live-reveal, edit-errors, edit-* selects

- Projects: uhd-3840. Example: `apps/web/e2e/screenshots/uhd-3840/host-live-question.png`
- Problem: At 3840 px the page type scales up, but fixed-pixel icons do not. The A-D answer glyphs in the host results card (~20 px) are smaller than the letter text next to them. The error warning triangle ('Give the quiz a title.') is tiny. Every select's native chevron is an ~8 px mark at the far right edge, easy to miss. On phones the same icons are text-height.
- Expected: Size glyphs, icons and select indicators in em or rem so they keep their proportion to the text at every breakpoint.
- Verifier's diagnosis (check it; it can be wrong): apps/web/src/screens/host/Distribution.tsx:45 (`<AnswerGlyph slot={r.slot} size={22} />` sets width and height in px), apps/web/src/screens/edit/ImageField.tsx:80 and the TextField error icon (`width="20" height="20"`), styled by apps/web/src/ui/TextField.module.css:68-71, and apps/web/src/ui/Controls.module.css:1-11 (native select arrow).
- Suggested fix: Add `.barLabel svg { width: 1.3em; height: 1.3em; }` to Host.module.css and `.error svg { width: 1.25em; height: 1.25em; }` to TextField.module.css:68. For selects, set `appearance: none` with an inline SVG chevron background sized `background-size: 1em` and `padding-right: 2.5em` in Controls.module.css .select.

### VC-64 (low) edit-question-single, edit-question-poll, edit-errors

- Projects: uhd-3840. Example: `apps/web/e2e/screenshots/uhd-3840/edit-question-single.png`
- Problem: Each answer's 'Remove' button sits lower than its input: its top is level with the input's bottom edge, so it lines up with the '6 / 80' counter instead of the field it removes.
- Expected: Align the Remove button with the input box itself (align-self to the input row), not with the input-plus-counter block.
- Verifier's diagnosis (check it; it can be wrong): apps/web/src/screens/edit/Editor.module.css:186-191. `.optionRow { align-items: flex-end }` aligns the button with the bottom of the label, input and counter block from TextField (the .meta counter row, TextField.module.css:53-58).
- Suggested fix: Keep flex-end and lift the button past the counter row: add `.optionRow > button { margin-bottom: calc(var(--fs-small) * 1.4 + 0.5rem); }` in Editor.module.css, which is the counter line height plus the field gap. Alternatively, render Remove inside the TextField's input row.

### VC-65 (low) edit-question-single, edit-question-truefalse, edit-question-poll, edit-question-wordcloud, edit-question-open, edit-question-rating, edit-errors

- Projects: phone-390-dark, phone-390-forced-colors, uhd-3840. Example: `apps/web/e2e/screenshots/uhd-3840/edit-question-single.png`
- Problem: The question editor has unexplained blank bands. There is a large gap under the image picker ('Choose File' / 'Remove image'), and another between the 'Answers' heading and 'Answer A' (or before 'Words per player', 'Scale' and so on). These are much bigger than the spacing anywhere else in the form, so the form looks like a section is missing.
- Expected: Use consistent vertical rhythm, for example by removing the empty legend or fieldset margin and the trailing margin after the file input.
- Verifier's diagnosis (check it; it can be wrong): apps/web/src/screens/edit/Editor.module.css:206-207 (`.status { min-height: 1.25rem }` on the empty `<p role="status">` at ImageField.tsx:75, plus the 0.5rem field gap). apps/web/src/ui/base.css:23-28 (the margin reset lists h1, h2, h3 and p but not h4), which affects the `<h4>Answers</h4>` at QuestionCard.tsx:62.
- Suggested fix: Add h4 to the reset selector in base.css:23-26 and the heading rules at base.css:30-32. In Editor.module.css:206-211, drop the min-height and add `.status:empty { display: none; }`. The live region stays mounted, so screen reader announcements still work.

### VC-66 (low) edit-quiz, edit-question-*, edit-errors, edit-conflict

- Projects: phone-390-dark, phone-390-forced-colors, uhd-3840. Example: `apps/web/e2e/screenshots/uhd-3840/edit-quiz.png`
- Problem: Select values ('3 seconds', 'Multiple choice', 'Standard') and the file input render in a different typeface and a smaller, lighter weight (Arial-like) than the inputs and labels, which use the bold system UI stack. The difference is most visible at 4K, where select text is noticeably smaller than the 'Friday night trivia' title field.
- Expected: Set font: inherit on select, option and input[type=file] so every form control uses the UI font and size.
- Verifier's diagnosis (check it; it can be wrong): apps/web/src/ui/base.css:42-47 applies `font: inherit` to button, input and textarea but not select. Selects therefore keep the UA font-family. apps/web/src/ui/Controls.module.css:9 also sets .select to 1.0625rem, while text inputs are 1.25rem (TextField.module.css:26).
- Suggested fix: In base.css:42-44, change the selector to `button, input, select, textarea { font: inherit; color: inherit; }`, which also covers input[type=file]. Optionally raise Controls.module.css:9 to `font-size: 1.25rem` to match the text fields.

### VC-68 (low) edit-conflict

- Projects: phone-390-dark, phone-390-forced-colors, uhd-3840. Example: `apps/web/e2e/screenshots/phone-390-forced-colors/edit-conflict.png`
- Problem: The 'Unsaved changes' status pill next to 'Save quiz' has the same outlined rounded-rectangle look as a button (especially in dark and forced colours), so it reads as a clickable control.
- Expected: Style status badges differently from buttons (no button border, a leading icon or dot, smaller size), as the host status pills do.
- Verifier's diagnosis (check it; it can be wrong): apps/web/src/ui/StatusLine.module.css:7-12. `.status:not(:empty)` uses `border: var(--outline-w) solid var(--ink); border-radius: var(--radius);`, the same treatment as Button.module.css:9-10.
- Suggested fix: In StatusLine.module.css:7-12, style it as a badge rather than a button: `border-radius: 999px; border-width: 1px; padding: 0.25rem 0.75rem;`, matching Host.module.css .chip. Optionally add a leading `::before` dot.

## Acceptance criteria

1. Every finding above is fixed as the lead's decisions say. If you conclude a finding is wrong, don't change code for it. Record it as a deviation with the evidence.
2. `pnpm --filter @zqhoot/web typecheck`, `pnpm --filter @zqhoot/web test` (includes the source scan) and `pnpm format:check` pass.
3. The gallery suite passes on all projects: `ZQ_E2E_PORT=4183 pnpm --filter @zqhoot/web test:e2e`. Other tasks run their own suites in parallel on other ports, so always set `ZQ_E2E_PORT=4183` for this task, for every Playwright run, including reviewers'. It takes about 9 minutes and covers axe, horizontal overflow and screenshots. Run it once at the end. While iterating, filter with `--grep <screen-id>` and `--project <name>`.
4. After the final run, open the regenerated screenshots in `apps/web/e2e/screenshots/<project>/<screen>.png` with the Read tool: every screen and project a finding names, plus the same screens at `phone-320`, `laptop-1366` and `uhd-3840`. Confirm each fix and check that nothing else on those screens got worse. List what you inspected in the report. Reviewers do the same.
5. No changes outside the files you own. No changes to `packages/*`, the servers, or the wire protocol.
6. Don't copy another product's look (hard requirement 6). Follow ADR-0016: colour is never the only cue, answers keep their letter and glyph, phones use rem, the presenter stage uses stage units.
