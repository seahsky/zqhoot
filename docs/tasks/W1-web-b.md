# W1-web-b: presenter, host control and quiz editor

Owner: Sonnet implementation agent. Reviewer: independent Opus agent. Builds on W1-web-a, already merged: read `apps/web/README.md` first, and follow its conventions for components, gallery registry and fixtures.

## Goal

Complete the web app's host side:

1. `/present`: the projector view
2. `/host`: sign-in, dashboard and live control
3. `/edit`: create, edit and duplicate quizzes with images

As in web-a, screens are presentational and driven by props. Containers wire them to the HTTP API (`packages/protocol/src/http.ts`) and the WebSocket `Connection`. No server exists yet; wave 2 runs everything end to end, so containers must follow the protocol exactly.

Read first:

- `apps/web/README.md`
- `docs/adr/0016-visual-identity.md` (**normative**: stage units, type scale, keyboard map, chart rules)
- `docs/adr/0004-wire-protocol.md`, `0005-timing-fairness-scoring.md`, `0006-answers-aggregation-reveal.md`, `0009-auth-and-identity.md`, `0011-media.md`
- `docs/research/responsive-display.md` sections 1, 2, 5 and 7
- `packages/protocol/src/*.ts`

## Files you own

- `apps/web/**`, except that `net/`, `state/player.ts`, `ui/tokens.css` and the web-a screens change only for bugs or needed extensions (list each change).
- No new dependencies (`qrcode` is already installed).

## Presenter (`/present?s={sessionId}`)

- **Stage:** `ui/Stage.tsx`, a 16:9 box letterboxed in the viewport.
  - `container-type: size`; every size in `cqh`, with a `min(1vh, 0.5625vw)` fallback via `@supports not (height: 1cqh)`.
  - Type scale from ADR-0016: countdown 18u, PIN 10u, question 7u auto-fit 5-8u, answers 5u, chart labels 4.5u, minimum 4.3u; padding 5cqh/5cqw.
  - Text-size control (100/125/150%) and light/dark stage toggle, both persisted in `localStorage` (try/catch).
- **Keyboard** (ADR-0016):
  - Space / → / PageDown = `host.next`, with the correct `from` guard; Enter = `host.close` while a question is open.
  - F = fullscreen, T = text size, D = dark/light, L = lock/unlock joining, ? = help overlay listing shortcuts.
  - No action on ←.
  - Keys are ignored while focus is in a form control.
  - Every control also has a visible, focusable button in a thin control bar. Hide it with a "Hide controls" toggle, but keep it keyboard-reachable.
- **Screens by phase** (from `HostSnapshot` + `stats`):
  - **Lobby:**
    - The join URL (`RuntimeConfig.joinUrl`) as text, and a QR code of `{joinUrl}?pin={pin}` generated with `qrcode.toString(..., {type:'svg'})` and rendered as `<img src="data:image/svg+xml;...">` (never inject SVG markup).
    - The PIN at 10u in groups of 3 ("482 915").
    - Live player count and a nickname wall that handles 400 names without overflowing: flowing columns, font step-down at thresholds, newest names first, and "+N more" beyond capacity.
    - "Start" hint for the keyboard.
  - **Question, get-ready** (`now < openAt`): question text large, image if any (`object-fit: contain`, max 45% of stage height), options shown dimmed, count-in to open.
  - **Question, open:** question, options with glyph + letter + text (neutral cards with ink outline), countdown (numeric plus a shrinking bar, bar hidden under reduced motion), and an "answers: 123 / 400" count from polled `stats`.
    - The presenter must never display the correct answer or live per-option distribution before the reveal, even though hosts receive them.
    - Live results **are** shown during the question for poll, word cloud, open-ended (visible responses only) and rating.
  - **Revealing:** "Time's up" beat.
  - **Reveal by type:**
    - single/truefalse: horizontal bars with direct labels "A · text · 14 · 47%", zero baseline, correct answer marked with a text badge "Correct" + thick outline + check icon.
    - poll: bars.
    - wordcloud: flowing tag cloud, sizes on a monotone scale by count (clamp 4.3u-12u), deterministic order, no rotation.
    - open: a wall of visible responses in cards, newest first, paging if too many.
    - rating: histogram + average ("Average 3.8 of 5").
    - Every chart has a visually hidden `<table>` alternative and a `role="status"` summary updated at most once a second.
  - **Leaderboard:** top 5 with rank, nickname, score and +delta. Movement is animated only when reduced motion is off, and never flashes.
  - **Ended:** a podium of the top 3 (a fade in, no confetti, no strobe), or, for quizzes without scored questions, a "Thanks for taking part" summary.
- **Polling:** while phase is `question`, send `host.stats` every `TIMING.statsPollMs`, starting at open. For open-ended questions page with the `after` cursor. Stop outside the question phase.
- **Auto-close:**
  - At the local deadline (`clock.toLocal(deadline)`), send `host.close {reason:'timer'}` once.
  - When `stats.answered >= stats.totalPlayers` and `totalPlayers > 0`, send `host.close {reason:'all-answered'}` once.
  - Both are idempotent server-side.

## Host (`/host`)

- **Auth** (`auth/`), selected by `RuntimeConfig.auth.mode`:
  - `local`: a username/password form → `POST /api/auth/login` → token kept in memory and `sessionStorage`.
  - `cognito`: a "Sign in" button → PKCE redirect (web-a's `auth/pkce.ts`) to `{domain}/oauth2/authorize` (client ID, `response_type=code`, scopes `openid email profile`, redirect URI `{origin}/host`, state, S256 challenge). On return, exchange the code at `{domain}/oauth2/token` (form-encoded, `grant_type=authorization_code`, `client_id`, `code_verifier`, `redirect_uri`) and use the **ID token** as the bearer. Refresh with the refresh token before expiry. Sign out clears tokens and redirects to `{domain}/logout?client_id=…&logout_uri={origin}/host`.
  - Password managers must work (autocomplete attributes) and paste must be allowed (WCAG 3.3.8).
- **Dashboard:**
  - Quizzes (`GET /api/quizzes`): open in the editor, duplicate, delete (with confirmation), "Start session" (`POST /api/sessions`).
  - Recent sessions (`GET /api/sessions`): open control, open presenter (new window/tab), download CSV (`GET /api/sessions/:id/results.csv` fetched with the auth header and saved via a Blob, since a plain link can't carry the header).
- **Live control** (`/host/live?s={sessionId}`): connects with `host.hello {client:'control'}`.
  - Shows the phase, question N of M, PIN and join URL, and a big "Next" button whose label reflects the action ("Start", "End question", "Show results", "Leaderboard", "Next question", "Finish").
  - Also: Skip question, End session (confirm), Lock/unlock joining, and "Open presenter" (`/present?s=`).
  - Roster: search, count, and a kick button per player (confirm).
  - Live stats with distribution (the host may see it).
  - Moderation queue for open-ended/word cloud: pending and visible responses with Show/Hide (`host.moderate`), newest first, keyboard-operable.
  - Uses its own `state/host.ts` reducer (pure, unit-tested like the player reducer), applying `welcome`, `host.state`, `roster`, `stats` and `error`, with `sv` ordering.

## Editor (`/edit?q={quizId|new}`)

- **Quiz fields:** title, settings (streak bonus, show questions on devices, read seconds), and an ordered question list with move up/down buttons (no drag-only interaction: WCAG 2.5.7), duplicate and delete.
- **Per-type editors:**
  - single: 2-4 options, choose the correct one with a radio
  - truefalse: correct = true/false
  - poll: 2-6 options
  - wordcloud: max entries 1-5
  - open: max entries 1-3, require approval (default on)
  - rating: max 3-10, min/max labels
  - Common fields: prompt, image, time limit (select from `TIME_LIMITS_SEC` plus "No limit"), points (none/standard/double) for scored types.
- New question defaults: time limit 20 s for scored types and 30 s for word cloud/open, standard points, fresh nanoid-like IDs generated with `crypto.getRandomValues` (no dependency).
- **Validation:** `QuizInput.safeParse` on save; errors mapped to fields and shown inline with an error summary at the top that links to the fields (WCAG 3.3.1).
- **Save:**
  - New quizzes use `POST /api/quizzes`.
  - Existing quizzes use `PUT /api/quizzes/:id` with `expectedVersion`. On 409, show "This quiz changed elsewhere" with the options to reload or overwrite (re-fetch the version, then save again).
  - Warn before leaving with unsaved changes.
- **Images:**
  - `POST /api/media/uploads {contentType, size}` → `UploadGrant`.
  - POST grants use `FormData` with every field first and the file last. PUT grants PUT the bytes with the given headers.
  - The client refuses anything other than PNG/JPEG/WebP/GIF, or larger than 5 MB, before requesting a grant. Show the preview from `mediaBaseUrl + key`; remove image.

## Gallery screens to add (fixtures in `dev/fixtures/`)

- `present-lobby`, `present-lobby-400`, `present-get-ready`, `present-question-open`, `present-question-image`, `present-question-long` (200-char prompt, 4 × 80-char options)
- `present-reveal-single`, `present-reveal-truefalse`, `present-reveal-poll`, `present-wordcloud`, `present-open`, `present-rating`
- `present-leaderboard`, `present-podium`, `present-ended-unscored`, `present-help`
- `host-login`, `host-dashboard`, `host-live-lobby`, `host-live-question`, `host-live-moderation`, `host-live-reveal`
- `edit-quiz`, `edit-question-single`, `edit-question-truefalse`, `edit-question-poll`, `edit-question-wordcloud`, `edit-question-open`, `edit-question-rating`, `edit-errors`, `edit-conflict`

They join web-a's Playwright matrix (all 6 projects).

- `present-*` screens are exempt from the horizontal-scroll check.
- Add a presenter composition test: at 1366x768, 1920x1080 and 3840x2160 the stage's bounding box is 16:9 and centred, and no element inside the stage overflows it (compare each element's `getBoundingClientRect` with the stage rect).
- For `present-lobby-400` and `present-question-long`, assert that no text overflows its container.

## Unit tests

- `state/host.ts` reducer: every message type, `sv` ordering, snapshots in every phase.
- Next-button action labels and `from` guards for every phase.
- Editor model: add/move/delete/duplicate, defaults per type, mapping zod issues to field paths.
- Upload request builder: POST and PUT grants, size/type pre-checks.
- Cognito URL builders (authorize, token body, logout).
- Presenter polling/auto-close controller as a pure state machine: start/stop on phase, timer close once, all-answered close once, cursor paging.

## Acceptance criteria

1. `pnpm --filter @zqhoot/web typecheck`, `test`, `build` and `test:e2e` pass. The full gallery (web-a + web-b screens) runs on all 6 projects with zero axe violations, no horizontal scroll on non-presenter screens, and the presenter composition and overflow tests passing.
2. The presenter never renders the correct answer or quiz answer distribution before the reveal, enforced by a gallery-level test on `present-question-open` against a fixture that contains the answer.
3. Keyboard map as specified, with the help overlay reachable by keyboard.
4. Containers follow the HTTP and WebSocket protocol exactly (types from `@zqhoot/protocol`, request bodies validated with its schemas before sending).
5. `pnpm exec prettier --check apps/web` passes. Comments explain non-obvious _why_ only.
6. Your report lists the screenshots you inspected (use the Read tool on the PNGs) and any visual issues found and fixed.
