# @zqhoot/web

The React + Vite app for every zqhoot view: landing, `/join`, `/play`, and (next task) `/host`, `/present` and `/edit`. Normative inputs: [ARCHITECTURE](../../docs/ARCHITECTURE.md), [ADR-0004](../../docs/adr/0004-wire-protocol.md) (wire protocol), [0005](../../docs/adr/0005-timing-fairness-scoring.md) (timing), [0008](../../docs/adr/0008-reconnect-resume.md) (reconnect and resume), [0013](../../docs/adr/0013-security.md) (security), [0016](../../docs/adr/0016-visual-identity.md) (visual identity).

This package delivers the foundations (router, design system, client libraries), the whole player experience, and a fixture-driven screen gallery with an accessibility and layout test matrix. Presenter, host and editor screens build on it.

## Commands

Run from the repository root with `pnpm --filter @zqhoot/web <script>`.

| Script      | What it does                                                                                                                         |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `dev`       | Vite dev server. The gallery is on. `/api`, `/config.json` and `/ws` proxy to a server on `localhost:8080`; with none, dev defaults. |
| `typecheck` | `tsc` (no emit) over `src`, `test`, `e2e` and the config files.                                                                      |
| `test`      | Vitest, node environment. Includes a test that builds the app and greps the output for gallery code.                                 |
| `build`     | Production build into `dist/`. Contains no gallery or fixture code.                                                                  |
| `test:e2e`  | Playwright matrix (Chromium only): builds with the gallery into `dist-e2e/`, serves it on port 4173, runs every spec.                |

`e2e/screenshots/` and `dist-e2e/` are gitignored. Screenshots are written to `e2e/screenshots/{project}/{screen}.png`, one directory per project (and per preference pass).

## Source layout

```
src/
  main.tsx            load runtime config (skipped for the gallery), mount <App/>
  app/                router (routing.ts is pure, router.tsx is the React binding), route table, gallery flag
  config/runtime.ts   /config.json -> RuntimeConfig; dev fallback
  net/                http, connection, clock, backoff, credentials, wakeLock
  auth/pkce.ts        PKCE helpers for the host login (used by the next task)
  state/player.ts     pure player reducer and view model; state/format.ts copy helpers
  ui/                 tokens.css, base.css, design-system components
  screens/            landing/, join/, play/ (presentational screens + page containers)
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
- **Planned reconnect:** after `plannedReconnectMs` it reconnects with a 0-500 ms jitter and resets the attempt counter. `Connection` knows nothing about game phases, and does not need to: the resume snapshot restores any phase. ADR-0008 wants it "between questions", so the optional `canReconnectNow: () => boolean` can hold it back (`PlayPage` returns false while a question is open). It is asked again every 5 s and the reconnect goes ahead regardless after 60 postponements (5 min, so at 115 min, before the 2 h cutoff). A callback that throws counts as "yes".
- **Frames:** each is `JSON.parse`d then `ServerMessage.safeParse`d. Anything invalid (not text, not JSON, wrong shape) is dropped with a `console.warn`. A valid message feeds `clock.observe(msg.ts, now())` before `onMessage`. `pong` is delivered like any other message.
- **Ended games:** `kicked`, and `error` with code `kicked`, `session-ended` or `protocol-version` (the server refuses this bundle's `v`; the same `hello` would be refused forever, so only a reload helps), are delivered to `onMessage` and then the connection stops itself (status `closed`), so a server that closes right after cannot trigger a pointless reconnect. Calling `stop()` from the container as well is harmless.
- **Status:** `connecting` only until the first attempt; every later attempt, including after a failure before the first open, reports `reconnecting`. `onStatus` and `onMessage` may call `stop()` re-entrantly.
- **Injection:** `WebSocketImpl`, `now`, `random`, `setTimer`, `clearTimer`, `document` and `window` are injectable. `setTimer`/`clearTimer` are typed as plain function shapes rather than `typeof setTimeout` (Node's typings add `__promisify__`, which no fake can provide); passing the real `setTimeout` still type-checks. `document: null` or `window: null` opts out of wake handling.

`JoinPage` creates a fresh `Connection` per join attempt (`join` is sent once, on open) and stops it once `welcome` arrives; `PlayPage` then opens its own with `resume`.

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

- **`sv`:** a `question`, `reveal`, `leaderboard` or `ended` with a lower `sv` than already applied is ignored; an equal one applies. A `welcome` snapshot always applies and resets `sv` to its own value, because a restarted VM server may have rolled back by up to a second. The snapshot fully determines the view (resume): question phases derive `get-ready`, `answering`, `submitted` (server-side responses) or `times-up` (`revealing`, or past the deadline) from it.
- **Acks:** `accepted` and `duplicate` are success. `rejected` removes the oldest optimistic response, shows the message from `NOTICE_COPY`, and for `too-late`/`not-open` moves to `times-up`. An `error` with `ref: 'answer'` releases the lock the same way. A `too-late` player is never stuck on a broken clock.
- **Word cloud and open-ended:** the screen is `answering` with no entries, then `submitted` with `remaining > 0` while more entries are allowed. It stays `submitted` with `remaining: 0` once the limit is reached (or the server says `limit`). The screens render the same input in both states, so focus is kept.
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

## Design system (`src/ui`)

`tokens.css` holds the ADR-0016 custom properties: `--bg`, `--surface`, `--ink`, `--ink-2`, `--ans-a` to `--ans-f`, focus ring (4 px ink, 3 px offset), outline width. Light is the default; `[data-theme="dark"]` and `prefers-color-scheme: dark` (unless `data-theme="light"`) switch to the dark stage. `prefers-contrast: more` makes secondary text ink, drops the tinted surface and thickens outlines. `prefers-reduced-motion` removes transitions and hides the countdown bar. Root font size steps up at 2560, 3200 and 3840 px wide, and everything is rem-based.

Components: `Button`/`ButtonLink`, `TextField`/`TextArea` (visible label, hint, error with `role="alert"`, counter), `AnswerGlyph`, `AnswerOption` (row of at least 72 px), `Countdown` (numeral, bar, coarse spoken updates), `StatusLine` (`role="status"`, always mounted), `PhoneShell` (safe-area gutters, `100svh`), `ResultIcon`, `VisuallyHidden`.

House rules: identity is never colour alone (letter and shape are always rendered as text and glyph); controls are at least 48 px; no `dangerouslySetInnerHTML`, no external fonts or network assets (a source-scan test enforces this); every screen has one `h1` and the page title is set with `usePageTitle`.

## Screen gallery

`/dev/gallery` lists every screen; `/dev/gallery?screen=<id>` renders exactly one, full page, wrapped only in `<div data-gallery-screen="<id>">`. Add `&theme=dark` (or `light`) to pin the stage theme.

The gallery exists when `import.meta.env.DEV || import.meta.env.VITE_ENABLE_GALLERY === '1'` (`app/gallery.ts`). A plain `vite build` drops the dynamic import, so `dist/` has no gallery or fixture code; `test/build.test.ts` builds twice (with and without the flag) and greps the output for gallery-only strings.

### Adding screens (presenter, host, editor)

Two lists, one line per screen in each, and the compiler checks they agree:

1. **`src/dev/manifest.ts`**: add `{ id: 'present-question', title: '...', group: 'present' }` to `SCREENS`. This file is plain data because Playwright imports it (it cannot import the React registry: CSS modules). Ids are `{group}-{name}`. Ids starting with `present-` skip the horizontal-scroll check.
2. **`src/dev/registry.tsx`**: add `'present-question': () => <Something {...fixture} />` to `RENDERERS`. Its type is `Record<ScreenId, () => ReactNode>`, so a missing or extra key is a compile error.

Fixtures live in `src/dev/fixtures/`, one file per group: `common.ts` (fixed `NOW`, ids, the demo player), `questions.ts`, `player.ts`. Add `present.ts`, `host.ts`, `edit.ts` alongside. Keep them plain TypeScript with no React or CSS imports, typed with protocol types, so `test/gallery-fixtures.test.ts` can validate them with the protocol schemas. The player fixtures are built by feeding real `ServerMessage`s through the real reducer (`PLAY_FIXTURES`), so a fixture cannot show a state the app cannot reach. Use the fixed `NOW` for anything time-based so screenshots never change.

`test/gallery-fixtures.test.ts` lists the screens this task requires; extend `REQUIRED` there for new ones.

## Tests

**Vitest (`test/`, node environment).** Pure modules only: `clock`, `backoff`, `connection` (fake WebSocket and fake timers: hello on every reconnect, backoff schedule, heartbeat, visibility and `pageshow`, planned reconnect, invalid frames, `stop()`), `credentials` (including throwing storage), `pkce`, `player` (every transition, `sv` ordering, resume snapshots for every phase, ack handling), `router`, `http`, `runtime-config`, `wake-lock`, format and copy helpers, gallery fixtures, a source scan (no `dangerouslySetInnerHTML`, `eval(`, `new Function(`, `http://`, external URLs), and the production build check. Test doubles are in `test/helpers/fakes.ts`.

**Playwright (`e2e/`), Chromium only** (`/opt/pw-browsers`; never run `playwright install`). Six projects exactly as in ADR-0016: `phone-320` (iPhone SE), `phone-390` (iPhone 14 with the viewport overridden to 390x844), `tablet-768` (iPad Mini), `laptop-1366`, `hd-1920` and `uhd-3840` (Desktop Chrome). Every project pins `browserName: 'chromium'`, because the phone descriptors default to WebKit.

- `gallery.spec.ts`: every screen in the manifest, in every project: axe with `wcag2a, wcag2aa, wcag21a, wcag21aa, wcag22aa` must report zero violations (no rule is disabled), `scrollWidth <= innerWidth` (except `present-*`), and a full-page screenshot.
- `preferences.spec.ts` (phone-390 only): the same checks with reduced motion, dark scheme, forced colors and more contrast, plus assertions that each preference changes the design (countdown bar hidden, `--ink-2` becomes ink, outlines thicken) and that answer rows are at least 72 px and every control at least 48 px. Apply preferences with `page.emulateMedia()`: in Playwright 1.56 here, `reducedMotion`, `forcedColors` and `contrast` given through `test.use()` are silently ignored (`matchMedia` stays false), and each pass asserts that its media query really matches. Emulated `forced-colors` changes only the media query, not the painted colours, so the forced-colors CSS (system colours for the countdown fill, result icons and glyph outlines; heavier borders in place of box-shadows) is written to spec but was not verified visually.
- `flow.spec.ts` (phone-390 only): the join and play containers against a scripted server (`page.routeWebSocket`): PIN, nickname, join, resume, a whole question round with the get-ready count-in, reveal, leaderboard, ended, reload mid-question, reconnect, a tap while offline, a typed answer that survives being offline or refused, word cloud entries, kicked, a stale bundle (`protocol-version`), blocked storage, inline errors with focus.

`webServer` builds with `VITE_ENABLE_GALLERY=1` into `dist-e2e/` (not `dist/`, so a gallery build can never be mistaken for the deployable one) and serves it with `vite preview` on port 4173, reusing a server that is already there.
