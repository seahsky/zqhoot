# W1-web-a: web foundation, client libraries, join/play, visual test matrix

Owner: Sonnet implementation agent. Reviewer: independent Opus agent. The follow-up task W1-web-b (presenter, host, editor) builds on this, so the foundations must be clean and documented.

## Goal

Create `apps/web`, the React + Vite app for every zqhoot view. This task delivers:

1. project setup, the design system and the tiny router
2. client libraries: runtime config, HTTP client, WebSocket connection with reconnect/heartbeat/clock sync, credential storage, PKCE helpers, wake lock, and the player state reducer
3. the complete player experience: landing, `/join`, `/play` (every state), wired to the protocol
4. a fixture-driven screen gallery and a Playwright + axe matrix over six viewports

No server exists yet. Everything is exercised through pure unit tests and the gallery.

Read first:

- `docs/ARCHITECTURE.md`
- `docs/adr/0004-wire-protocol.md`, `0005-timing-fairness-scoring.md`, `0008-reconnect-resume.md`, `0009-auth-and-identity.md`, `0013-security.md`, `0016-visual-identity.md` (**normative for all visual decisions**)
- `docs/research/responsive-display.md`, section "Design rules for zqhoot"
- all of `packages/protocol/src/*.ts`

## Files you own

- `apps/web/**` (`package.json` already exists with pinned dependencies; do not add dependencies)
- `.gitignore`: you may append lines (e.g. `apps/web/e2e/screenshots/`)

## Environment notes

- Only **Chromium** is installed (Playwright browsers at `/opt/pw-browsers`, env `PLAYWRIGHT_BROWSERS_PATH` is set). `@playwright/test` is pinned to 1.56.1 to match the installed build. Never run `playwright install`. Device descriptors such as `iPhone SE` default to WebKit, so override `browserName: 'chromium'` in every project.
- There is no jsdom/happy-dom. Vitest runs in the `node` environment, so keep logic in pure modules that can be tested there. Components are verified via the gallery and Playwright.

## Architecture of `apps/web/src`

```
main.tsx            mount, load runtime config (except gallery), render <App/>
app/router.tsx      tiny pathname + query router (no library): useRoute(), navigate(), <Link>
app/App.tsx         route table: / → Landing, /join, /play, /host*, /present, /edit* (web-b), /dev/gallery (only if gallery enabled)
config/runtime.ts   fetch('/config.json') → RuntimeConfig.safeParse; dev fallback when served by `vite` dev with no config
net/http.ts         typed fetch wrapper: JSON bodies, `Authorization: Bearer`, ApiError → thrown ApiRequestError {status, error, message}
net/connection.ts   Connection class (below)
net/clock.ts        ServerClock (below)
net/backoff.ts      fullJitterDelay(attempt, {baseMs, capMs}, random)
net/credentials.ts  save/load/clear player credentials (ADR-0008)
net/wakeLock.ts     request/release/re-request on visibility; silent failure
auth/pkce.ts        createVerifier(), challengeS256(verifier) (WebCrypto), buildAuthorizeUrl(...), parseCallback(...)
state/player.ts     playerReducer + PlayerView types (pure)
ui/                 design system components + CSS
screens/landing/    Landing
screens/join/       JoinPinScreen, JoinNicknameScreen (+ JoinPage container)
screens/play/       one presentational component per player state (+ PlayPage container)
dev/fixtures/       typed fixtures (protocol types) for every gallery screen
dev/Gallery.tsx     /dev/gallery lists screens; /dev/gallery?screen=<id> renders one full-page, nothing else
```

Presentational screens take plain props (state + callbacks) and never touch the network. Containers (`JoinPage`, `PlayPage`) wire the libraries to the screens. The gallery renders presentational screens from fixtures.

### `net/connection.ts` (contract used by web-b and wave 2)

```ts
export type ConnectionStatus = 'idle' | 'connecting' | 'open' | 'reconnecting' | 'closed';
export interface ConnectionOptions {
  url: string;
  /** Called on every (re)connect before anything else is sent; return the join/resume/host.hello message or null. */
  hello: () => ClientMessage | null;
  onMessage: (msg: ServerMessage) => void;
  onStatus?: (s: ConnectionStatus) => void;
  WebSocketImpl?: typeof WebSocket; // injectable for tests
  now?: () => number; // local wall clock
  random?: () => number;
  setTimer?: typeof setTimeout;
  clearTimer?: typeof clearTimeout;
  document?: Pick<Document, 'visibilityState' | 'addEventListener' | 'removeEventListener'> | null;
  window?: Pick<Window, 'addEventListener' | 'removeEventListener'> | null;
}
export class Connection {
  constructor(opts: ConnectionOptions);
  readonly clock: ServerClock;
  start(): void;
  /** Returns false if not open (caller decides whether to queue). */
  send(msg: ClientMessage): boolean;
  /** Permanent stop (ended/kicked/leave): no reconnect. */
  stop(): void;
  get status(): ConnectionStatus;
}
```

Behaviour (ADR-0008):

- **Backoff:** full jitter with `TIMING.reconnectBaseMs` / `TIMING.reconnectCapMs`; unlimited attempts; the attempt counter resets after 10 s open.
- **Visibility:** on `visibilitychange` → visible, or `pageshow`, when not open: reconnect after a random 0-500 ms delay.
- **Heartbeat:** after `TIMING.heartbeatIdleMs` with no inbound message, send `ping {t}`. No `pong` (or any message) within `TIMING.pongTimeoutMs` → close and reconnect.
- **Planned reconnect:** after `TIMING.plannedReconnectMs`.
- **Every inbound frame:** `JSON.parse` + `ServerMessage.safeParse`. Invalid frames are dropped with `console.warn`. Valid ones feed `clock.observe(msg.ts, now())` before `onMessage`.
- **Server-ended messages:** `error` with code `kicked`/`session-ended`, or a `kicked` message, are delivered, and the container calls `stop()`.

### `net/clock.ts`

```ts
export class ServerClock {
  /** offset = min over observations of (localReceive - ts). Never lets the client think the server is ahead of reality (ADR-0005). */
  observe(serverTs: number, localReceive: number): void;
  get offsetMs(): number | null;
  /** Local wall time at which the given server time occurs. */
  toLocal(serverTime: number): number;
  serverNow(localNow: number): number;
  reset(): void; // on reconnect
}
```

### `state/player.ts`

A pure reducer from `ServerMessage`s and local events to a `PlayerView`. It is discriminated by `screen`:

- `lobby`
- `get-ready` (question shown, now < openAt)
- `answering` (by question type)
- `submitted` (locked in; for word cloud/open, can add more until the limit)
- `times-up`
- `reveal` (correct / incorrect / unscored / no-answer variants)
- `leaderboard` (own standing)
- `ended` (final standing, podium names)
- `kicked`
- `session-over` (error `session-ended` / `not-found`)

Rules:

- Honour `sv`: ignore state messages with a lower `sv` than already applied.
- Time-based screens take `now` from a `tick` action, so the reducer is deterministic.
- Track `answer.ack` results: `rejected` shows a reason message from a copy table; `duplicate` is treated as success.
- The welcome snapshot fully determines the view, which is how resume works.

## Player UX (every state in the gallery)

Copy is our own (ADR-0016), in plain sentences. Suggested strings; improve them if needed but keep them original:

- "Enter the game PIN"
- "Pick a nickname"
- "You're in. Watch the big screen."
- "Get ready: options open in 3"
- "Answer locked in"
- "Time's up"
- "Correct, +870"
- "Not this time"
- "Thanks, your response is in"
- "You're 4th, 120 points behind Kim"
- "Reconnecting…"
- "The host removed you from this game"
- "This game has ended"

Screens:

- **Landing (`/`):** product name, "Join a game" (primary, to /join), "Host a game" (to /host).
- **`/join`:**
  - PIN field: `inputmode="numeric"`, `autocomplete="one-time-code"` off, 6 digits, prefilled from `?pin=`; the QR opens `/join?pin=123456`.
  - Uses `GET /api/join/:pin`, then shows the quiz title and the nickname field (`maxlength` 64 raw, live grapheme counter against 16), then connects and sends `join`.
  - Nickname errors from `error` codes (`nickname-invalid`, `nickname-taken`, `session-locked`, `session-full`, `rate-limited`) are shown inline and announced (`aria-describedby` + `role="alert"`), with focus returned to the field.
  - On `welcome`, save credentials and navigate to `/play?s={sessionId}`.
- **`/play`:**
  - Loads credentials (ADR-0008) and connects with `resume`. With no credentials, redirects to `/join`.
  - Header strip: nickname, score, connection status (`role="status"`).
  - **Answering by type:**
    - single: 2-4 options; poll: up to 6; truefalse: 2.
    - Each option is a ≥72 px row: glyph + letter + text on a neutral card with an ink outline. Stacked below a 420 px container width; 2x2 above that only when every option is ≤ 24 characters.
    - The question prompt is shown when present.
    - Tapping sends `answer`; the view is then locked.
    - wordcloud: text input (25 chars) + submit, entries remaining; submitted entries listed.
    - open: textarea (200 chars) + counter + submit.
    - rating: `1..max` buttons in a single row that wraps, plus min/max labels.
  - **Countdown:** numeric, tabular numerals; a shrinking outline bar hidden under `prefers-reduced-motion`. It uses the clock (`toLocal(openAt)`, `toLocal(deadline)`).
  - **Get-ready:** options visible but disabled until local `openAt`, with a numeric count-in.
  - **Reveal:** correct/incorrect shown with an icon **and** text (never colour alone), points gained, streak (e.g. "3 in a row"), score and rank.
- **Wake lock** is requested while on `/play`.

## Design system (ADR-0016; exact values there)

- `ui/tokens.css`:
  - CSS custom properties for light (default) and dark stage (`[data-theme="dark"]`), including `--ans-a` … `--ans-f`.
  - Focus ring: 4 px ink, 3 px offset, visible on every surface.
  - `prefers-reduced-motion` and `prefers-contrast: more` variants.
  - System font stack; `font-variant-numeric: tabular-nums` utility.
- `ui/AnswerGlyph.tsx`: SVG glyphs A hexagon, B plus, C star, D dome (path data in ADR-0016 / research §6.4), E pentagon, F X-cross. Each is filled with its token, with a 3-4 px ink outline, `aria-hidden`; the letter is rendered as text next to it.
- Components (typed props, CSS modules or plain CSS): `Button` (primary/secondary, ≥48 px), `TextField` (visible label, hint, error, ≥16 px font), `AnswerOption`, `Countdown`, `StatusLine` (`role="status"`), `PhoneShell` (safe-area gutters `max(16px, env(safe-area-inset-*))`, `min-height: 100vh; min-height: 100svh`), `VisuallyHidden`.
- No `dangerouslySetInnerHTML`, no external fonts, CDNs or network assets. `index.html`:
  - viewport `width=device-width, initial-scale=1, viewport-fit=cover` (never `maximum-scale`/`user-scalable=no`)
  - `<html lang="en">`
  - a meta theme-color

## Gallery and Playwright matrix

- Gallery is enabled when `import.meta.env.DEV || import.meta.env.VITE_ENABLE_GALLERY === '1'`. The production build without the flag must not include gallery code: use a dynamic import behind the flag and assert it in a test by grepping `dist`.
- Screen IDs (all required in this task):
  - `landing`, `join-pin`, `join-pin-error`, `join-nickname`, `join-nickname-error`
  - `play-lobby`, `play-get-ready`
  - `play-answer-single`, `play-answer-single-long` (four options at 80 chars each), `play-answer-truefalse`, `play-answer-poll-6`, `play-answer-wordcloud`, `play-answer-open`, `play-answer-rating`
  - `play-submitted`, `play-times-up`
  - `play-reveal-correct`, `play-reveal-incorrect`, `play-reveal-unscored`, `play-reveal-no-answer`
  - `play-leaderboard`, `play-ended`, `play-reconnecting`, `play-kicked`, `play-session-over`

  web-b adds `present-*`, `host-*` and `edit-*` to the same registry, so design the registry to make that a one-line addition per screen.

- `playwright.config.ts`: six projects exactly as in ADR-0016/research §8 (320x568 via `iPhone SE`, 390x844 via `iPhone 14` with the viewport overridden, 768x1024 via `iPad Mini`, and Desktop Chrome at 1366x768, 1920x1080 and 3840x2160), all with `browserName: 'chromium'`.
  - `webServer`: `VITE_ENABLE_GALLERY=1 pnpm build && pnpm preview --port 4173 --strictPort`, reusing an existing server.
- `e2e/gallery.spec.ts`, for every registered screen × every project:
  - (a) `AxeBuilder` with tags `wcag2a, wcag2aa, wcag21a, wcag21aa, wcag22aa` → zero violations. If a rule is disabled, the reason is in code and in the report.
  - (b) For non-`present-*` screens: `document.documentElement.scrollWidth <= innerWidth`.
  - (c) A full-page screenshot to `e2e/screenshots/{project}/{screen}.png` (gitignored).
  - Also emulate `reducedMotion: 'reduce'` for one pass on the 390 project, and `colorScheme`/`forcedColors` where cheap.
- Add a `test:e2e` script (already present). The whole matrix must pass locally: `pnpm --filter @zqhoot/web test:e2e`.

## Unit tests (Vitest, node environment, `apps/web/test/`)

- `clock` (min filter, reset, conversions)
- `backoff` (bounds, distribution with injected random)
- `connection`, with a fake WebSocket class and fake timers (inject `setTimer`):
  - hello on every (re)connect
  - backoff scheduling
  - heartbeat ping then timeout-reconnect
  - visibility reconnect
  - planned reconnect
  - invalid frames dropped
  - `stop()` prevents reconnects
- `credentials` (sessionStorage primary, localStorage mirror, throwing storage)
- `pkce` (RFC 7636 appendix B test vector for S256)
- `playerReducer` (every screen transition, `sv` ordering, resume snapshots for every phase, ack handling)
- `router`
- A source scan test forbidding `dangerouslySetInnerHTML`, `eval(`, `new Function(` and `http://` URLs in `src/`.

## Acceptance criteria

1. `pnpm --filter @zqhoot/web typecheck`, `test` and `build` pass; `test:e2e` passes the full matrix (all listed screens × 6 projects) with zero axe violations and no horizontal scroll.
2. The production build contains no gallery or fixture code (test-enforced).
3. The Connection, ServerClock, credentials and player-reducer contracts above are implemented as specified, documented in `apps/web/README.md` (for web-b and wave 2 authors) and unit-tested.
4. Visuals follow ADR-0016: glyphs, tokens, sizes, tap targets ≥ 48 px, answer rows ≥ 72 px, answers never distinguished by colour alone.
5. `pnpm exec prettier --check apps/web` passes. Comments explain non-obvious _why_ only.
6. Your report lists which screenshots you personally inspected, and anything that looked wrong.
