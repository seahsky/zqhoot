# @zqhoot/web

The React + Vite app for every zqhoot view: landing, `/join`, `/play`, `/host`, `/present` and `/edit`. Normative inputs: [ARCHITECTURE](../../docs/ARCHITECTURE.md), [ADR-0004](../../docs/adr/0004-wire-protocol.md) (wire protocol), [0005](../../docs/adr/0005-timing-fairness-scoring.md) (timing), [0008](../../docs/adr/0008-reconnect-resume.md) (reconnect and resume), [0013](../../docs/adr/0013-security.md) (security), [0016](../../docs/adr/0016-visual-identity.md) (visual identity).

This package delivers the foundations (router, design system, client libraries), the whole player experience, the host side (presenter, live control, dashboard and quiz editor), and a fixture-driven screen gallery with an accessibility and layout test matrix.

## Commands

Run from the repository root with `pnpm --filter @zqhoot/web <script>`.

| Script      | What it does                                                                                                                                   |
| ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `dev`       | Vite dev server. The gallery is on. `/api`, `/config.json`, `/media` and `/ws` proxy to a server on `localhost:8080`; with none, dev defaults. |
| `typecheck` | `tsc` (no emit) over `src`, `test`, `e2e` and the config files.                                                                                |
| `test`      | Vitest, node environment. Includes a test that builds the app and greps the output for gallery code.                                           |
| `build`     | Production build into `dist/`. Contains no gallery or fixture code.                                                                            |
| `test:e2e`  | Playwright matrix (Chromium only): builds with the gallery into `dist-e2e/`, serves it on port 4173, runs every spec.                          |

`e2e/screenshots/` and `dist-e2e/` are gitignored. Screenshots are written to `e2e/screenshots/{project}/{screen}.png`, one directory per project (and per preference pass).

## Source layout

```
src/
  main.tsx            load runtime config (skipped for the gallery), mount <App/>
  app/                router (routing.ts is pure, router.tsx is the React binding), route table, gallery flag
  config/runtime.ts   /config.json -> RuntimeConfig; dev fallback
  net/                http, connection, clock, backoff, credentials, wakeLock, hostApi, upload
  auth/               pkce (primitives), cognito (URLs and token replies), session (HostAuth), useHostAuth
  state/              player (pure reducer), host (pure reducer for control and presenter), commands,
                      driver (polling and auto-close), presenterView, charts, editor, format
  ui/                 tokens.css, base.css, design-system components, Stage, HostShell, Controls, ConfirmDialog
  screens/            landing/, join/, play/, present/, host/, edit/ (presentational screens + page containers)
  dev/                gallery: manifest.ts, registry.tsx, Gallery.tsx, fixtures/
test/                 Vitest (node)
e2e/                  Playwright
```

Presentational screens take plain props and never touch the network. Containers (`JoinPage`, `PlayPage`) wire the libraries to the screens. The gallery renders presentational screens from fixtures.

## Runtime config

`loadRuntimeConfig()` fetches `/config.json` and validates it with the protocol's `RuntimeConfig`. `main.tsx` stores it with `setRuntimeConfig()`; screens read it with `getRuntimeConfig()` (it throws if called before it is set, which cannot happen for a mounted screen). If loading fails, production shows a "can't reach the server" screen with a retry button; under `vite dev` it falls back to same-origin defaults (`ws(s)://{host}/ws`, `apiBaseUrl: ''`, local auth). The gallery route (`/dev/gallery`) never loads it.

## Client libraries

### `net/connection.ts`: `Connection`

```ts
const conn = new Connection({
  url: config.wsUrl,
  hello: () => ({ type: 'resume', v: PROTOCOL_VERSION, sessionId, playerId, token }), // or host.hello
  onMessage: (msg) => {
    /* validated ServerMessage */
  },
  onStatus: (s) => {
    /* 'idle' | 'connecting' | 'open' | 'reconnecting' | 'closed' */
  },
});
conn.start();
conn.send({ type: 'answer', questionIndex: 0, payload }); // false if not open: you decide whether to queue
conn.clock.toLocal(msg.openAt);
conn.stop(); // permanent; no reconnect
```

Behaviour (ADR-0008):

- **hello** is called on every (re)connect and sent before anything else. Return `null` to send nothing. For hosts, return a `host.hello` with a fresh token each time.
- **Backoff:** full jitter, `random(0, min(reconnectCapMs, reconnectBaseMs * 2^attempt))`, unlimited attempts. The attempt counter resets only after the socket has stayed open for 10 s, so a flapping link keeps backing off.
- **Wake:** on `visibilitychange` to visible, or `pageshow`, when the socket is not open, it reconnects after a random 0-500 ms, replacing any longer pending backoff. A socket that is `CLOSED` or `CLOSING` without a close event (WebKit after the back/forward cache) counts as not open. A socket still `CONNECTING` or `OPEN` is left alone.
- **Heartbeat:** after `heartbeatIdleMs` with no inbound frame (of any kind, even one that fails validation) it sends `ping {t}`. No frame within `pongTimeoutMs` and it abandons the socket and reconnects, without waiting for the browser's own close timeout. If the ping cannot even be sent (the socket is `CLOSING` or `CLOSED` but its close event never arrived, which WebKit does), the link is treated as dead at once: abandon and reconnect, no waiting for a wake event.
- **Planned reconnect:** after `plannedReconnectMs` it reconnects with a 0-500 ms jitter and resets the attempt counter. `Connection` knows nothing about game phases, and does not need to: the resume snapshot restores any phase. ADR-0008 wants it "between questions", so the optional `canReconnectNow: () => boolean` can hold it back. Every page that owns a connection passes one, built from a pure function in `state/reconnect.ts` that `test/reconnect.test.ts` pins for every screen and phase: `playerMayReconnect(screen)` (`PlayPage`: false on `get-ready`, `answering` and `submitted`) and `hostMayReconnect(phase)` (`useHostSession`, so the control page and the presenter: false in phases `question` and `revealing`, and true before the first snapshot). That test also runs both inside a real `Connection` and reducer: no new socket while a question is open, one at the next check after the reveal. It is asked again every 5 s and the reconnect goes ahead regardless after 60 postponements (5 min, so at 115 min, before the 2 h cutoff). A callback that throws counts as "yes".
- **Frames:** each is `JSON.parse`d then `ServerMessage.safeParse`d. Anything invalid (not text, not JSON, wrong shape) is dropped with a `console.warn`. A valid message feeds `clock.observe(msg.ts, now())` before `onMessage`. `pong` is delivered like any other message.
- **Ended games:** `kicked`, and `error` with code `kicked`, `session-ended` or `protocol-version` (the server refuses this bundle's `v`; the same `hello` would be refused forever, so only a reload helps), are delivered to `onMessage` and then the connection stops itself (status `closed`), so a server that closes right after cannot trigger a pointless reconnect. Calling `stop()` from the container as well is harmless.
- **Status:** `connecting` only until the first attempt; every later attempt, including after a failure before the first open, reports `reconnecting`. `onStatus` and `onMessage` may call `stop()` re-entrantly.
- **Injection:** `WebSocketImpl`, `now`, `random`, `setTimer`, `clearTimer`, `document` and `window` are injectable. `setTimer`/`clearTimer` are typed as plain function shapes rather than `typeof setTimeout` (Node's typings add `__promisify__`, which no fake can provide); passing the real `setTimeout` still type-checks. `document: null` or `window: null` opts out of wake handling.

`JoinPage` creates a fresh `Connection` per join attempt (`join` is sent once, on open) and stops it once `welcome` arrives; `PlayPage` then opens its own with `resume`.

A refused nickname says why. The server's `nickname-invalid` error carries the reason in its `message` (`too-short`, `too-long`, `invalid-characters` or `inappropriate`), and `joinErrorMessage` (`screens/join/copy.ts`) turns each into its own sentence (`NICKNAME_REASON_COPY` in `screens/join/nickname.ts`); an unknown reason, or prose from an older server, gets the generic one. The join screen also checks the UTF-8 size locally with `TextEncoder` (`LIMITS.nicknameMaxBytes`, 96): a name of 13 flag emoji is 13 characters but 104 bytes, and the server would refuse it. The check gives the same "too long" sentence before anything is sent, and the live counter, which keeps counting graphemes ("13 / 16"), adds a warning as soon as either cap is passed. The copy never says "Game PIN" (a Kahoot term): the label is "PIN" and the heading "Enter the PIN from the big screen".

### `net/clock.ts`: `ServerClock`

`offset = min(localReceive - ts)` over every observation since the last `reset()`. Downlink latency only ever adds to that difference, so the minimum converges on the true offset from above: the client can open options a few tens of ms late but never early (ADR-0005). `toLocal(serverTime)` and `serverNow(localNow)` treat a missing offset as 0. `Connection` resets the clock on every open. `offsetMs` is `null` until the first message; do not tick countdowns from `serverNow` while it is `null`, because a device clock can be minutes off.

### `state/player.ts`: `playerReducer`

A pure reducer, `(PlayerState, PlayerAction) => PlayerState`. Read `state.view`, a union discriminated by `screen`:

`connecting`, `lobby`, `get-ready`, `answering`, `submitted`, `times-up`, `reveal` (variants `correct`, `incorrect`, `unscored`, `no-answer`), `leaderboard`, `ended`, `kicked`, `session-over`, `out-of-date`.

Actions:

- `{ type: 'message', msg }`: any `ServerMessage`.
- `{ type: 'tick', now }`: `now` is **estimated server time**, `conn.clock.serverNow(Date.now())`. Time-based transitions (`get-ready` to `answering` at `openAt`, `answering` to `times-up` after `deadline`) happen only here, which keeps the reducer deterministic. Time never moves backwards, and message `ts` values also advance it.
- `{ type: 'connection', status }`: kept in `state.connection`; the screen is never blanked while reconnecting.
- `{ type: 'answer.sent', index, payload }` / `{ type: 'answer.unsent', index }`: after `conn.send` returned true or false. A sent answer locks the screen at once (optimistic).

Rules:

- **`sv`:** a `question`, `reveal`, `leaderboard` or `ended` with a lower `sv` than already applied is ignored; an equal one applies. A `welcome` snapshot is judged **per connection**. The reducer knows whether anything has been applied since the connection last entered `connecting` or `reconnecting` (`state.fresh`). The first snapshot or state message of a connection always applies, and a `welcome` that is first sets `sv` to its own value even when that is lower, because a restarted VM server may have rolled back by up to a second and the snapshot is the truth. After that, a `welcome` applies only if `snap.sv >= state.sv`; an older one lost the race to a broadcast (the resume was answered after the host had already opened the question) and is ignored, or the player would sit in the lobby for a whole question. The snapshot fully determines the view (resume): question phases derive `get-ready`, `answering`, `submitted` (server-side responses) or `times-up` (`revealing`, or past the deadline) from it. In phase `reveal` it also carries the question (`reveal.question`), so a resumed single-choice reveal shows the correct-answer card; a server that leaves it out falls back to the question the page already held for that index.
- **Acks:** `accepted` and `duplicate` are success. Acks come back in send order, so each one answers the oldest send still waiting. `rejected` removes that optimistic response, shows the message from `NOTICE_COPY`, and for `too-late`/`not-open` moves to `times-up`. `duplicate` removes it too (the server already holds an identical entry, so it is not listed twice; no notice, nothing handed back to the field), unless the server reports more entries than this page has confirmed, in which case the optimistic copy is the one the server holds and stays. An `error` with `ref: 'answer'` releases the lock the same way. A `too-late` player is never stuck on a broken clock.
- **Word cloud and open-ended:** the screen is `answering` with no entries, then `submitted` with `remaining > 0` while more entries are allowed. It stays `submitted` with `remaining: 0` once the limit is reached (or the server says `limit`). The screens render the same input in both states, so focus is kept.
- **Lost text comes back:** a text entry that `Connection.send()` accepted but the server never acknowledged dies with the socket. When the resume snapshot for the same question does not hold it, the oldest such entry becomes `restore` (with a new `seq`) so the field refills. `seq` keeps counting across the resume.
- **Refused text comes back:** the entry field is cleared when a text is sent, so when the server rejects it the reducer puts it in `restore: { text, seq }` on the `answering` or `submitted` view. `TextEntry` refills the field from it (only if the field is empty; `seq` changes on every refusal), including when the field is remounted, as for a one-entry open question that had shown "answer locked in". Sending again clears it. An entry that never left the phone (`answer.unsent`) is not cleared in the first place: `PlayScreen`'s `onAnswer` returns whether the answer was handed to the socket, and `TextEntry` only empties the field when it was.
- **Final states:** `kicked`, `session-over` (`error` `session-ended` or `not-found`) and `out-of-date` (`error` `protocol-version`) ignore everything after them. `PlayPage` clears the credentials for the first two but keeps them for `out-of-date`, because the player is still in the game: the Reload button resumes it.

### `net/credentials.ts`

`saveCredentials`, `loadCredentials(hintSessionId)`, `clearCredentials(sessionId)` implement ADR-0008: primary copy in `sessionStorage['zqhoot:session']`, mirror in `localStorage['zqhoot:session:{sessionId}']`. Load prefers sessionStorage, then the mirror when the URL hint (`/play?s=`) names its session, and puts the mirror back into sessionStorage. A hint that disagrees with sessionStorage wins. Mirrors older than 24 h are pruned on save. Every access is wrapped in try/catch; storage is injectable (`CredentialStorages`). Both copies are cleared on `ended`, `kicked`, `leave`, or a rejected token. `holdInMemory` and `loadCredentialsOrHeld` are the last-resort hand-off from `/join` to `/play` for a browser that blocks both stores, so a successful join is never stranded (a reload cannot resume there).

### Other libraries

- `net/http.ts`: `createHttpClient({ baseUrl, getToken })`; JSON in and out, `Authorization: Bearer`, optional protocol schema for the reply. Failures throw `ApiRequestError { status, error, message }` (`status: 0`, `error: 'network'` when no reply arrived).
- `net/backoff.ts`: `fullJitterDelay(attempt, { baseMs, capMs }, random)`.
- `net/wakeLock.ts`: `createWakeLock()` with `acquire()`/`release()`; re-requests on `visibilitychange`; every failure is silent.
- `auth/pkce.ts`: `createVerifier`, `challengeS256` (WebCrypto, RFC 7636 appendix B vector in the tests), `createState`, `buildAuthorizeUrl`, `parseCallback` (rejects a state mismatch), `buildTokenRequest`, `buildRefreshRequest`. Nothing here stores anything; the caller keeps verifier and state between redirect and callback.
- `app/router.tsx`: `useRoute()` (`{ path, query }`), `navigate(to, { replace })`, `<Link to>`, `matchPath('/host*', path)`. `navigate` refuses anything that is not a same-origin absolute path.

## Host side

Everything under `/host`, `/present` and `/edit` sits behind `HostGate` (`screens/host/HostGate.tsx`): signed out, it shows the sign-in for the deployment's auth mode and remembers the page to return to. Presentational screens take plain props; the containers (`DashboardPage`, `LivePage`, `PresentPage`, `EditPage`) wire them to the HTTP API and the WebSocket.

### Sign-in (`auth/`)

`HostAuth` (`session.ts`) is a framework-free controller, one per page load (`getHostAuth()`); `useHostAuth` binds it to React.

- **`local`:** a username and password form (`autocomplete` `username` and `current-password`, no paste handler) posts to `POST /api/auth/login`. The token is kept in memory and in `sessionStorage['zqhoot:host:auth']`.
- **`cognito`:** "Sign in" runs authorization code + PKCE. The verifier, state and the page to return to go in `sessionStorage['zqhoot:host:pkce']`; the redirect URI is `{origin}/host`. On return `start()` checks the state, exchanges the code at `{domain}/oauth2/token` (form-encoded) and uses the **ID token** as the bearer. Only the refresh token is stored (`sessionStorage`); it is used a minute before the ID token expires and after a 401. Sign-out clears everything and goes to `{domain}/logout?client_id=…&logout_uri={origin}/host`. `start()` runs once, so React StrictMode cannot spend a login code twice.
- The login response does not say whether `expiresAt` is seconds or milliseconds, so both are accepted (`toEpochMs`).
- `net/hostApi.ts` validates every request body with the protocol schema before sending and every reply after it arrives, checks ids before they go into a path, and retries once after `onUnauthorized` returns true. That includes the image upload's grant request (`requestUpload`); the second request of an upload goes to the grant's own URL and carries no bearer. The web package has no direct zod dependency, so `listOf()` wraps a protocol schema into an array parser.
- The presenter is opened with `window.open` (never a `noopener` link), because a new tab then inherits the opener's `sessionStorage` and is already signed in.

### The host reducer and the driver (`state/host.ts`, `state/driver.ts`)

`hostReducer` folds `welcome` (host), `host.state`, `roster`, `stats` and `error` into `HostState`; control and presenter share it.

- **`sv`:** a `host.state` with a lower `sv` than applied is dropped, an equal one applies. A `welcome` snapshot follows the player's per-connection rule: it always applies as the first thing a connection delivers (a restarted server may have rolled back), and afterwards only if `snap.sv >= state.sv`. The roster comes from the snapshot and is then patched by `roster` deltas, kept in arrival order (the wall shows it newest first). A delta that overtakes a snapshot generated before it can be lost until the next snapshot; deltas carry no version.
- **Live figures** belong to one question and reset when it changes. Open-ended pages are merged by response id (the server's status wins). A moderation updates the list at once, because the server sends no ack; a refused one (`error` with `ref: 'host.moderate'`) bumps `moderationFailures`, which makes the poller re-read from the first page. A refused `host.close` (`rate-limited`, `conflict`, `internal`; not `bad-request`, which would only fail again) bumps `closeRefusals`, which makes the driver send the close again.
- **Final errors** (`unauthorized`, `forbidden`, `session-ended`, `not-found`, `protocol-version`) set `ended`. An expired sign-in is refreshed and the connection reopened; the others stop it.
- **`driverStep`** is the polling and auto-close machine, pure and fed by the container: `host.stats` every `TIMING.statsPollMs` from `openAt`, the last non-null open-ended `cursor` as `after` (the next page at once when a reply says more is waiting; once a walk has reached the end, only that tail is polled, and every `REWALK_MS` the whole list is read again from the first page, because the other window moderates over its own connection and the server tells the presenter nothing, so a response hidden or approved on an early page would otherwise never reach the projector), `host.close {timer}` once when the estimated server time passes `deadline` (the spec's `clock.toLocal(deadline) <= now`, in server time), and `host.close {all-answered}` once when `answered >= totalPlayers > 0`. A close the server refused is retried after a wait that doubles from one second to eight (`close.refused`). Word cloud and open-ended questions that take more than one entry are not closed early by "everyone has answered once". Polling stops when the phase leaves `question`, and after a close. Both the presenter and the control run one; closing twice is a no-op on the server.
- **Next button** (`state/commands.ts`): Start, End question, Show results, Leaderboard (after a question that awards points), Next question, Finish (on the last question), each carrying `from {phase, questionIndex}`.

### Presenter (`/present?s=`)

- **Stage** (`ui/Stage.tsx`): a 16:9 box letterboxed in the viewport, `container-type: size`, every size in stage units (`--u` = 1cqh, with `min(1vh, 0.5625vw)` under `@supports not (height: 1cqh)`). Type scale from ADR-0016. The text-size control (100, 125, 150%) multiplies the essential sizes; the light/dark toggle sets `data-theme` on the page. Both are kept in `localStorage` (`zqhoot:present:text-scale`, `zqhoot:present:theme`), in try/catch.
- **What the room may see** (`state/presenterView.ts`): hosts receive the correct answer and the live distribution while a question is open, so `presentQuestion()` rebuilds the question field by field into a type that has nowhere to put an answer, and live charts are made only for poll, word cloud, open-ended (visible responses only) and rating. Single choice and true/false show only "answered / total" until the reveal. `test/presenter-view.test.ts` searches the view for the answer fields, and `e2e/present.spec.ts` checks the rendered page against a fixture that contains the answer and a distinctive distribution (211, 88, 61, 17).
- **Fitting** (`screens/present/layout.ts`, `questionFit.ts`): CSS cannot size text to its box, so prompts, options, the nickname wall, the word cloud and the response wall are measured with a deliberately wide font model (`charEm`). The prompt takes 8u down to 5u; the countdown floats beside it, so the first lines are shorter; options take 5u down to 4.3u and go compact when one is long, and every card is measured on its own (two to a row, a row as tall as its taller card). A long question already sits on those floors at 100%, so at 125% and 150% the countdown numeral is what gives way (`fitQuestion` steps its text-size multiplier down until the cards fit, never below 100%); the nickname wall (`nameWall`) lays names out as flowing chips, newest first, and takes the largest of 5, 4.6, 4.3, 4, 3.75 and 3.5u at which every name fits, so more names share a row as the type shrinks. Only when even 3.5u (the ADR-0016 floor for non-essential text) overflows are the oldest dropped and counted in a last "+N more" chip. The count of players sits beside the PIN (not under the join block) to leave the wall its 58u: at 400 players the fixture shows 64 names at 100% text size (`present.spec.ts` asserts at least 60 at 1366, 1920 and 3840, and that they are the newest, whole and in order). `lobbyWallHeightU` budgets the join block from measured heights (the title is cut to two lines, the join line may wrap, the PIN and join line grow with the text-size control). The running header ("Question 3 of 10") and the answer count live in the stage's 5% top margin.
- **Charts** (`screens/present/charts.tsx`): horizontal bars with direct labels ("A · text · 14 · 47%"), a zero baseline, and the correct answer marked with a "Correct" badge, a check icon and a thicker outline; a tag cloud with sizes monotone in votes (4.3u to 12u) and a deterministic order; a wall of approved responses, dealt into columns and paged; a rating histogram with its average. Every chart is `aria-hidden` and carries a visually hidden `<table>` and a `role="status"` sentence updated at most once a second (`useThrottled`).
- **Keyboard** (`screens/present/keys.ts`, pure and tested): Space, right arrow and Page Down send `host.next` with the `from` guard; Enter sends `host.close` while a question is open; F fullscreen, T text size, D theme, L lock joining, ? help. The left arrow does nothing. Keys typed into a form control are ignored, Space and Enter are left to a focused button (or the button would press twice), Ctrl/Cmd/Alt combinations are left to the browser, and with the help open only ? answers. Every action also has a button in the control bar, which sits outside the stage (in its bottom margin, or in the letterbox); "Hide controls" fades it, and it comes back while it holds focus or the pointer.
- **Motion:** the leaderboard slides rows to their new place with one ease and no opacity change; the podium fades in; both only when `prefers-reduced-motion` is off, and never flash. The countdown bar is hidden under reduced motion.

### Editor (`/edit?q={id|new}`)

`state/editor.ts` is the model: a `QuizInput`-shaped draft and pure functions (add, move, delete, duplicate, change type, options), defaults per type (20 s for scored types, 30 s for word cloud and open-ended, 20 s for poll and rating; standard points; ids from `crypto.getRandomValues`, 21 URL-safe characters), dirty tracking, and `validateDraft`, which runs the protocol's `QuizInput.safeParse` and maps every zod issue to a field id (`f-questions-2-options-1-text`) and a plain sentence. The screen shows an error summary that links to each field (opening the question first), inline messages, and follows edits so fixed problems disappear.

- **Save:** new quizzes `POST /api/quizzes` and then replace the URL with the new id; existing ones `PUT /api/quizzes/:id` with `expectedVersion`. A 409 shows "This quiz changed elsewhere" with Reload (take the server's version) or Overwrite (re-fetch the version, then save again).
- **Leaving:** `beforeunload` is armed while there are unsaved changes, and the header links ask first (`HostShell`'s `onLeave`).
- **Images** (`net/upload.ts`): PNG, JPEG, WebP and GIF up to 5 MB are checked before any grant is requested (SVG is refused by name). A POST grant becomes a `FormData` with every grant field first and the file last, and no headers of its own; a PUT grant sends the bytes with the grant's headers and no `Authorization` (the signed token is in the URL). The preview is `mediaBaseUrl + key`.
- Reordering uses Move up and Move down buttons (WCAG 2.5.7), not dragging.

### Live control (`/host/live?s=`)

`LiveScreen` shows the phase, question N of M, PIN and join URL, the big Next button (label from `nextAction`), Skip, Lock/Unlock, End session (confirmed), Open presenter, the question with its distribution (hosts may see it, and the correct answer), the roster (search, count, Kick with a confirmation), and the moderation queue for open-ended questions: pending, visible and hidden responses newest first, each with a Show or Hide button. Word cloud entries cannot be moderated one by one, because `stats` carries aggregated words without response ids.

## Design system (`src/ui`)

`tokens.css` holds the ADR-0016 custom properties: `--bg`, `--surface`, `--ink`, `--ink-2`, `--ans-a` to `--ans-f`, focus ring (4 px ink, 3 px offset), outline width. Light is the default; `[data-theme="dark"]` and `prefers-color-scheme: dark` (unless `data-theme="light"`) switch to the dark stage. `prefers-contrast: more` makes secondary text ink, drops the tinted surface and thickens outlines. `prefers-reduced-motion` removes transitions and hides the countdown bar. Root font size steps up at 2560, 3200 and 3840 px wide, and everything is rem-based.

Components: `Button`/`ButtonLink` (`size="compact"` for dense host screens), `TextField`/`TextArea` (visible label, hint, error with `role="alert"`, counter, optional `fieldId`), `SelectField`/`CheckboxField`/`RadioGroup` (`Controls.tsx`), `AnswerGlyph`, `AnswerOption` (row of at least 72 px), `Countdown` (numeral, bar, coarse spoken updates), `StatusLine` (`role="status"`, always mounted), `PhoneShell` (safe-area gutters, `100svh`), `HostShell`, `ConfirmDialog` (native `<dialog>`, focus starts on Cancel), `Stage`, `ResultIcon`, `VisuallyHidden`.

`PhoneShell` anchors actions and answers to the bottom on phones (the thumb zone). From 700 px wide, in landscape or taller than 900 px, it groups the content and centres it vertically with a bounded gap instead (`--push` and `--fill` custom properties, so screens do not repeat the media query).

House rules: identity is never colour alone (letter and shape are always rendered as text and glyph); controls are at least 48 px; no `dangerouslySetInnerHTML`, no external fonts or network assets (a source-scan test enforces this); every screen has one `h1` and the page title is set with `usePageTitle`.

## Screen gallery

`/dev/gallery` lists every screen; `/dev/gallery?screen=<id>` renders exactly one, full page, wrapped only in `<div data-gallery-screen="<id>">`. Add `&theme=dark` (or `light`) to pin the stage theme.

The gallery exists when `import.meta.env.DEV || import.meta.env.VITE_ENABLE_GALLERY === '1'` (`app/gallery.ts`). A plain `vite build` drops the dynamic import, so `dist/` has no gallery or fixture code; `test/build.test.ts` builds twice (with and without the flag) and greps the output for gallery-only strings.

### Adding screens

Two lists, one line per screen in each, and the compiler checks they agree:

1. **`src/dev/manifest.ts`**: add `{ id: 'present-question', title: '...', group: 'present' }` to `SCREENS`. This file is plain data because Playwright imports it (it cannot import the React registry: CSS modules). Ids are `{group}-{name}`. Ids starting with `present-` skip the horizontal-scroll check. Group `test` holds screens that only exist to prove a check can fail (`test-overflow`, an element 150vw wide): they are in `SCREENS` (so the registry and the index list them) but not in `MATRIX_SCREENS`, which the axe, screenshot and preference passes use.
2. **`src/dev/registry.tsx`**: add `'present-question': () => <Something {...fixture} />` to `RENDERERS`. Its type is `Record<ScreenId, () => ReactNode>`, so a missing or extra key is a compile error.

Fixtures live in `src/dev/fixtures/`, one file per group: `common.ts` (fixed `NOW`, ids, the demo player, `JOIN_URL`), `questions.ts`, `player.ts`, `hostSnapshots.ts` (full questions, rosters, snapshot builders; unit tests use it too), `hostState.ts` (feeds real host messages through the real reducer), `present.ts`, `host.ts`, `edit.ts`, `images.ts`. The host and presenter fixtures deliberately contain the correct answer and a live distribution, as a real host snapshot does. Keep them plain TypeScript with no React or CSS imports, typed with protocol types, so `test/gallery-fixtures.test.ts` can validate them with the protocol schemas. The player fixtures are built by feeding real `ServerMessage`s through the real reducer (`PLAY_FIXTURES`), so a fixture cannot show a state the app cannot reach. Use the fixed `NOW` for anything time-based so screenshots never change.

`test/gallery-fixtures.test.ts` lists the screens this task requires; extend `REQUIRED` there for new ones.

## Tests

**Vitest (`test/`, node environment).** Pure modules only: `clock`, `backoff`, `connection` (fake WebSocket and fake timers: hello on every reconnect, backoff schedule, heartbeat, visibility and `pageshow`, planned reconnect, invalid frames, `stop()`), `credentials` (including throwing storage), `pkce`, `player` (every transition, `sv` ordering, resume snapshots for every phase, ack handling, an unacknowledged text entry handed back after a resume), `host` (every message type, `sv` ordering, a snapshot in every phase), `commands` (Next-button labels and `from` guards), `driver` (polling, timer close once, all-answered close once, cursor paging, the periodic re-walk, a refused close retried), `presenter-moderation` (the driver and reducer against a server that pages 150 responses: a response hidden or approved on the first page reaches the wall), `presenter-view` (screens by phase, nothing secret before the reveal), `present-layout`, `present-question-fit` and `present-keys` (text fitting, the wall, the cloud, the question layout at every text size, the keyboard map), `editor` (add, move, delete, duplicate, defaults, zod issues mapped to fields, a picture attached by question id, edits kept across a save), `upload` (POST and PUT grants, pre-checks, the grant request refreshed after a 401), `cognito` (authorize, token, refresh and logout builders), `host-auth` (both sign-in modes, refresh, sign-out, throwing storage), `host-api`, `router`, `http`, `runtime-config`, `wake-lock`, format and copy helpers, gallery fixtures, a source scan (no `dangerouslySetInnerHTML`, `eval(`, `new Function(`, `http://`, external URLs), and the production build check. Test doubles are in `test/helpers/fakes.ts`.

**Playwright (`e2e/`), Chromium only** (`/opt/pw-browsers`; never run `playwright install`). Six projects exactly as in ADR-0016: `phone-320` (iPhone SE), `phone-390` (iPhone 14 with the viewport overridden to 390x844), `tablet-768` (iPad Mini), `laptop-1366`, `hd-1920` and `uhd-3840` (Desktop Chrome). Every project pins `browserName: 'chromium'`, because the phone descriptors default to WebKit.

- `gallery.spec.ts`: every screen in the manifest, in every project: axe with `wcag2a, wcag2aa, wcag21a, wcag21aa, wcag22aa` must report zero violations (no rule is disabled), `scrollWidth <= clientWidth` of the document element (except `present-*`), and a full-page screenshot. The measure must be `clientWidth`, not `window.innerWidth`: with mobile emulation an over-wide page inflates `innerWidth` to fit it (1280 for the 320 px phone), so a check against it can never fail. A self-test (`the horizontal-scroll check can fail`) opens `test-overflow` in every project and requires the same helper (`expectNoHorizontalScroll` in `e2e/helpers.ts`, which also checks the layout viewport really is the project's width) to reject it, phone-320 included; all real screens, the host and editor ones too, pass it in all six projects.
- `preferences.spec.ts` (phone-390 only): the same checks with reduced motion, dark scheme, forced colors and more contrast, plus assertions that each preference changes the design (countdown bar hidden, `--ink-2` becomes ink, outlines thicken) and that answer rows are at least 72 px and every control at least 48 px. Apply preferences with `page.emulateMedia()`: in Playwright 1.56 here, `reducedMotion`, `forcedColors` and `contrast` given through `test.use()` are silently ignored (`matchMedia` stays false), and each pass asserts that its media query really matches. Emulated `forced-colors` changes only the media query, not the painted colours, so the forced-colors CSS (system colours for the countdown fill, result icons and glyph outlines; heavier borders in place of box-shadows) is written to spec but was not verified visually.
- `present.spec.ts` (hd-1920 only, sets its own viewports): the stage is 16:9 and centred at 1366x768, 1920x1080 and 3840x2160 for every `present-*` screen, and no element inside it leaves its rectangle; `present-lobby-400` shows at least 60 names (newest first, whole, the rest counted) and `present-lobby` all 22 at the biggest type; `present-lobby-400` and `present-question-long` have no text that overflows its container, also at 125% and 150% text size, where nothing may leave the stage's content area either (that check runs for every `present-*` screen at 1366x768 and 1920x1080); `present-question-open` (a fixture that contains the answer and a distribution) shows neither, its option cards are indistinguishable, and the reveal does show the answer so the check can fail; charts have a table and a status line; reduced motion hides the countdown bar.
- `host.spec.ts` (hd-1920 only): sign-in with the local form (autocomplete, paste allowed) and with Cognito (PKCE redirect, code exchange, ID token as bearer, logout URL, state mismatch), the dashboard (duplicate, delete with confirmation, CSV download with the bearer header, start session, presenter tab), live control (Next with the `from` guard, lock, skip, kick, end, stats polling, moderation from the keyboard, timer close once), the presenter (keyboard map, ignored while typing, text size and theme remembered, help overlay by keyboard, hidden control bar still reachable, stats polling and auto-close, reveal, reconnect) and the editor (create, error summary and links, every question type, move up and down, 409 reload and overwrite, leave guard, image upload and refusals, an upload that ends after a reorder, edits typed during a save, the open card following a swap).
- `flow.spec.ts` (phone-390 only): the join and play containers against a scripted server (`page.routeWebSocket`): PIN, nickname, join, resume, a whole question round with the get-ready count-in, reveal, leaderboard, ended, reload mid-question, reconnect, a tap while offline, a typed answer that survives being offline or refused, word cloud entries, kicked, a stale bundle (`protocol-version`), blocked storage, inline errors with focus, nickname errors by reason, the byte counter.

`scripted.ts` (`ScriptedServer`) and `host-api.ts` (an in-memory host API that records every request) are shared by the flow specs. The gallery helper waits for finite animations and image decoding before it scans and photographs a screen.

The config runs two workers whatever the machine: on a busy or large host, several 3840x2160 pages at once (full-page screenshots are large software rasters) made Chromium report "Page crashed" in one review run, while the same tests passed alone.

`webServer` builds with `VITE_ENABLE_GALLERY=1` into `dist-e2e/` (not `dist/`, so a gallery build can never be mistaken for the deployable one) and serves it with `vite preview` on port 4173, reusing a server that is already there.
