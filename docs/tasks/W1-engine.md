# W1-engine: pure game engine + protocol tests

Owner: Sonnet implementation agent. Reviewer: independent Opus agent.

## Goal

Implement `packages/engine`: the pure, transport- and storage-agnostic game logic of zqhoot. Add protocol schema tests in `packages/protocol/test`. The service layer (built later, in wave 2) calls these functions: it loads records from a `Store`, calls the engine, persists what the engine returns and delivers the messages. The engine performs **no I/O**, reads **no clock** (time is always a parameter), and generates **no random values** (IDs are parameters).

Read first: `docs/ARCHITECTURE.md` and ADRs 0003, 0004, 0005, 0006, 0009 in `docs/adr/`. Then `packages/protocol/src/*.ts` (the wire contract) and `packages/engine/src/model.ts` (domain records).

## Files you own

- `packages/engine/**` (except `src/model.ts`, which you may extend with optional fields only; list any change under deviations)
- `packages/protocol/test/**` (new)
- `packages/protocol/src/**`: only minimal fixes for real bugs you find. List every change under deviations with the reason.

Do not touch other packages or root config. Dependencies already installed: `@zqhoot/protocol`, `obscenity@0.4.6`, and at the root `vitest@5.0.2` and `@vitest/coverage-v8@5.0.2`. Do not add dependencies.

## Required public API (`packages/engine/src/index.ts` re-exports all)

Names and signatures below are the contract the service layer will code against. Keep them exactly; add helpers freely.

```ts
// config.ts
export interface EngineConfig {
  minLeadMs: number; // TIMING.minLeadMs.lambda | .node
  answerGraceMs: number; // TIMING.answerGraceMs
  sessionTtlMs: number; // default 30 days
}
export const DEFAULT_SESSION_TTL_MS: number; // 30 * 24 * 3600 * 1000

// nickname.ts
export type NicknameResult =
  | { ok: true; nickname: string; key: string }
  | { ok: false; reason: 'too-short' | 'too-long' | 'invalid-characters' | 'inappropriate' };
export function normalizeNickname(raw: string): NicknameResult;

// text.ts
export function normalizeWord(raw: string): string | null; // word-cloud entry; null if unusable
export function normalizeOpenText(raw: string): string | null; // open-ended entry; null if unusable
export function containsProfanity(text: string): boolean;

// questions.ts
export function toPublicQuestion(q: Question, settings: QuizSettings): PublicQuestion;
export function questionLimitMs(q: Question): number | null;
export function isScoringQuestion(q: Question): boolean; // scored type AND points multiplier > 0

// scoring.ts
export function basePoints(i: {
  correct: boolean;
  elapsedMs: number | null;
  limitMs: number | null;
  multiplier: 0 | 1 | 2;
}): number;
export function streakBonus(i: { streak: number; multiplier: 0 | 1 | 2; enabled: boolean }): number;
/** Sort by score desc, then nickname (code-point order), then playerId; assign competition ranks. */
export function rankEntries<T extends { playerId: string; nickname: string; score: number }>(
  entries: T[],
): Array<T & { rank: number }>;

// session.ts
export function createSession(i: {
  sessionId: string;
  pin: string;
  hostId: string;
  quiz: Quiz;
  now: number;
  cfg: EngineConfig;
  maxPlayers?: number;
}): { meta: SessionMeta; snapshot: QuizSnapshot };
export function isExpired(meta: SessionMeta, now: number): boolean;
export type JoinCheck =
  | { ok: true }
  | { ok: false; code: 'not-found' | 'session-ended' | 'session-locked' | 'session-full' };
export function checkJoinable(
  meta: SessionMeta | null,
  playerCount: number,
  now: number,
): JoinCheck;

export type HostTransitionCommand =
  HostNextMsg | HostCloseMsg | HostSkipMsg | HostEndMsg | HostLockMsg; // z.infer types from protocol
export type TransitionEffect =
  | { kind: 'none' }
  | { kind: 'question-opened'; questionIndex: number }
  | { kind: 'closing'; questionIndex: number } // now phase 'revealing': caller must run the reveal after settling
  | { kind: 'retry-reveal'; questionIndex: number } // phase already 'revealing': caller re-runs the reveal
  | { kind: 'leaderboard'; questionIndex: number }
  | { kind: 'ended' }
  | { kind: 'lock-changed'; locked: boolean };
export type TransitionResult =
  | { ok: true; meta: SessionMeta; effect: TransitionEffect }
  | { ok: false; code: ErrorCode; message: string };
export function applyHostCommand(
  meta: SessionMeta,
  snapshot: QuizSnapshot,
  cmd: HostTransitionCommand,
  now: number,
  cfg: EngineConfig,
): TransitionResult;
/** VM timer expiry; same as host.close {reason:'timer'} for `questionIndex`. */
export function timerClose(meta: SessionMeta, questionIndex: number, now: number): TransitionResult;

// answers.ts
export type AnswerDecision =
  | { kind: 'accept'; response: ResponseRecord }
  | { kind: 'duplicate'; existing: ResponseRecord }
  | { kind: 'reject'; reason: AnswerRejectReason };
export function evaluateAnswer(i: {
  meta: SessionMeta;
  snapshot: QuizSnapshot;
  playerId: string;
  questionIndex: number;
  payload: AnswerPayload;
  receivedAt: number;
  existing: ResponseRecord[]; // this player's stored responses for this question
  cfg: EngineConfig;
}): AnswerDecision;

// reveal.ts
export interface RevealOutput {
  meta: SessionMeta; // phase 'reveal', version + 1
  stored: StoredQuestionResult; // host-view result + per-player outcomes
  scoreboard: Scoreboard; // appliedThrough = questionIndex
  hostResult: QuestionResult;
  playerMessages: PlayerMessage[]; // one 'reveal' per non-kicked player
}
export interface PlayerMessage {
  playerId: string;
  message: OutboundMessage;
}
export function computeReveal(i: {
  meta: SessionMeta;
  snapshot: QuizSnapshot;
  responses: ResponseRecord[];
  players: PlayerRecord[];
  scoreboard: Scoreboard | null;
  now: number;
}): RevealOutput;
/** Reveal already computed and stored (retry after a crash): rebuild the meta transition and messages. */
export function revealFromStored(i: {
  meta: SessionMeta;
  stored: StoredQuestionResult;
  players: PlayerRecord[];
}): {
  meta: SessionMeta;
  hostResult: QuestionResult;
  playerMessages: PlayerMessage[];
};
export function toPlayerResult(result: QuestionResult): QuestionResult; // open-ended: only 'visible', no nicknames

// views.ts
export function buildQuestionMessage(meta: SessionMeta, snapshot: QuizSnapshot): OutboundMessage; // type 'question'
export function buildLeaderboard(i: {
  meta: SessionMeta;
  scoreboard: Scoreboard;
  players: PlayerRecord[];
}): {
  entries: LeaderboardEntry[];
  playerMessages: PlayerMessage[];
};
export function buildEnded(i: {
  meta: SessionMeta;
  snapshot: QuizSnapshot;
  scoreboard: Scoreboard | null;
  players: PlayerRecord[];
}): {
  podium: LeaderboardEntry[];
  playerMessages: PlayerMessage[];
};
export function buildRoster(
  players: PlayerRecord[],
  connectedPlayerIds: ReadonlySet<string>,
): RosterEntry[];
export function buildPlayerSnapshot(i: {
  meta: SessionMeta;
  snapshot: QuizSnapshot;
  player: PlayerRecord;
  players: PlayerRecord[];
  scoreboard: Scoreboard | null;
  responses: ResponseRecord[]; // this player's, current question
  result: StoredQuestionResult | null; // current question's, if revealed
}): PlayerSnapshot;
export function buildHostSnapshot(i: {
  meta: SessionMeta;
  snapshot: QuizSnapshot;
  players: PlayerRecord[];
  connectedPlayerIds: ReadonlySet<string>;
  scoreboard: Scoreboard | null;
  result: StoredQuestionResult | null;
}): HostSnapshot;
export function computeLiveStats(i: {
  question: Question;
  responses: ResponseRecord[];
  players: PlayerRecord[];
  after?: string;
}): LiveStats;

// csv.ts
export function buildResultsCsv(i: {
  meta: SessionMeta;
  snapshot: QuizSnapshot;
  players: PlayerRecord[];
  scoreboard: Scoreboard | null;
  results: StoredQuestionResult[];
  responsesByQuestion: ResponseRecord[][];
}): string;
```

## Behaviour rules

### Nicknames (ADR-0009)

1. NFKC. Strip zero-width and other default-ignorable format characters (`\p{Cf}` except bidi controls, `\p{Default_Ignorable_Code_Point}`). **Reject** bidi controls (U+061C, U+200E-200F, U+202A-202E, U+2066-2069), `\p{Cc}`, `\p{Co}`, `\p{Cn}`, and line/paragraph separators, with `invalid-characters`.
2. Collapse runs of `\p{Zs}` to one ASCII space and trim.
3. Reject more than 3 consecutive non-spacing or enclosing marks (`\p{Mn}`, `\p{Me}`) on one base (anti-Zalgo) with `invalid-characters`. Spacing marks (`\p{Mc}`) do not count. This was amended after review: the original rule of 2 per grapheme rejected ordinary Hindi and Bengali spellings.
4. Count graphemes with `Intl.Segmenter` (granularity `grapheme`): fewer than `LIMITS.nicknameMinGraphemes` gives `too-short`, more than `LIMITS.nicknameMaxGraphemes` gives `too-long`.
5. `key` (uniqueness skeleton): lowercase, then a documented confusables map (at least Cyrillic and Greek letters that look like Latin: а е о р с у х і ј ѕ ԁ ӏ and Α Β Ε Ζ Η Ι Κ Μ Ν Ο Ρ Τ Υ Χ ο ν ι κ etc.), then leetspeak digits/symbols (0→o 1→l 3→e 4→a 5→s 7→t @→a $→s), then drop spaces and punctuation. Emoji are kept in the key. If the key is empty, return `invalid-characters`.
6. `inappropriate` if `obscenity` (English dataset + `englishRecommendedTransformers`) matches the normalised nickname or the key.
7. `nickname` is the output of steps 1-2, as displayed. Examples: `"Ana"` and `"ana"` and `"Аna"` (Cyrillic А) share a key. `"  Kim   Lee "` becomes `"Kim Lee"`. `"Bob​"` becomes `"Bob"`. `"a‮b"` is rejected. A 16-emoji name is accepted and a 17-emoji name is too long.

### Text

- `normalizeWord`: NFKC, strip as for nicknames (reject → null), collapse whitespace, trim, lowercase (`toLocaleLowerCase('und')` is not available everywhere, so use `toLowerCase()`), strip leading/trailing punctuation. Return null if empty or longer than `LIMITS.wordMaxLength` code points.
- `normalizeOpenText`: NFKC, strip invisible characters, reject controls (→ null), collapse horizontal whitespace, keep single newlines (at most 3), trim. Null if empty or longer than `LIMITS.openTextMax`.
- `containsProfanity`: `obscenity` English dataset + recommended transformers.

### Questions

- `toPublicQuestion` never outputs `correctOptionId`, `correct`, `requireApproval` or any answer-derived field. It omits `prompt` when `settings.showQuestionOnDevices` is false. Test this by checking `JSON.stringify` of the public form against every question type.
- `questionLimitMs`: `timeLimitSec * 1000`, or null.

### Scoring (ADR-0005)

- `basePoints`: 0 if not correct or `multiplier` is 0. If `limitMs` is null, `1000·m`. Else `r = clamp((elapsedMs - 250)/(limitMs - 250), 0, 1)` and `points = Math.round(1000·m·(1 - 0.6·r))`. Handle `limitMs ≤ 250` without dividing by zero (full points).
- `streakBonus`: `enabled && streak ≥ 2 ? 100·m·min(streak-1, 3) : 0`.

### Session state machine (ADR-0003/0005/0006)

- `createSession`:
  - `phase 'lobby'`, `questionIndex -1`, `version 1`, `locked false`, `maxPlayers = LIMITS.maxPlayersDefault` unless given.
  - `expiresAt = now + cfg.sessionTtlMs`.
  - `hasScoredQuestions` is true if any question `isScoringQuestion`.
  - The snapshot deep-copies the quiz questions and settings.
- Every change returns a new meta object with `version + 1`. A no-op returns `{ok:true, effect:{kind:'none'}}` with the **same** meta (same version).
- `host.next`: if `cmd.from` does not equal `{phase, questionIndex}` → no-op. Otherwise:
  - `lobby`: open question 0.
  - `question`: behaves like `host.close {reason:'manual'}` (so a clicker's single key can close).
  - `revealing`: `retry-reveal` (meta unchanged, version unchanged).
  - `reveal`: if the question `isScoringQuestion`, go to `leaderboard`; else open the next question, or `ended` after the last.
  - `leaderboard`: open the next question, or `ended`.
  - `ended`: no-op.
- **Opening question i:** `phase 'question'`, `questionIndex i`, `openAt = now + max(settings.readSeconds*1000, cfg.minLeadMs)`, `deadline = limit ? openAt + limit : null`, `closedAt null`.
- `host.close {questionIndex}`: in `question` with a matching index → `phase 'revealing'`, `closedAt = now`, effect `closing`. That includes before `openAt`. With a matching index in `revealing`/`reveal`/`leaderboard`, or a mismatched index → no-op. Invalid in `lobby`/`ended` → no-op.
- `host.skip {questionIndex}`: in `question` with a matching index → add to `skipped` and open the next question (or `ended`). Otherwise no-op.
- `host.end`: any phase except `ended` → `ended`, `endedAt = now`, timing fields null. `ended` → no-op.
- `host.lock {locked}`: if the value changes → `lock-changed`; else no-op. Allowed in any phase except `ended` (ended → no-op).
- `timerClose(meta, i, now)` = `host.close {questionIndex:i, reason:'timer'}`.
- `checkJoinable`:
  - null or expired → `not-found`
  - ended → `session-ended`
  - locked → `session-locked`
  - `playerCount ≥ maxPlayers` → `session-full`
  - otherwise ok (late joiners are allowed in every other phase)

### Answers (ADR-0005/0006)

Check in this order:

1. **Phase.** Not `question` with a matching `questionIndex` → `reject not-open`, except when phase is `revealing`/`reveal`/`leaderboard` for the same index → `reject too-late`.
2. **Timing.**
   - `receivedAt < openAt - 250` → `too-early`.
   - `deadline !== null && receivedAt > deadline + cfg.answerGraceMs` → `too-late`.
3. **Payload kind** must match the question type (single/poll: `choice`; truefalse: `boolean`; wordcloud/open: `text`; rating: `rating`), else `invalid`. The option must exist, the rating must be in `1..max`, and text must normalise (else `invalid`).
4. **Duplicates and entry limits.** Allowed entries: 1 for single-response types, `maxEntries` for wordcloud/open.
   - If `existing` contains an entry with the same payload (same normalised text for text types) → `duplicate` with that record.
   - Else, if `existing.length ≥ allowed` → `reject limit`.
5. **Accept.** Build the record:
   - `slot = existing.length`, `responseId = playerId + '-' + slot`.
   - `elapsedMs = limit === null ? null : clamp(receivedAt - openAt, 0, limit)`.
   - `correct`: single `optionId === correctOptionId`, truefalse `value === correct`, else null.
   - `points = basePoints(...)` for scored types, else 0.
   - `normalizedText` for text types.
   - `status`:
     - open: profane → `hidden`, else `requireApproval ? 'pending' : 'visible'`
     - wordcloud: profane → `hidden`, else `visible`
     - all other types: `visible`

### Reveal

- **Preconditions** (throw on violation, since this is a service bug): `computeReveal` requires `meta.phase === 'revealing'` and `scoreboard?.appliedThrough < questionIndex` (or a null scoreboard).
- **Inputs used.** Responses for `meta.questionIndex` from non-kicked players only. `totalPlayers` = non-kicked players. `answered` = distinct players with at least one included response.
- **Result by type:**
  - single/poll: counts per option ID (all options present, zeros included).
  - truefalse: `{true, false}` counts.
  - wordcloud: counts `normalizedText` of `visible` responses; top `LIMITS.wordCloudTopN`, sorted by count desc then text.
  - open: every response as `OpenResponseView` with status and nickname (host view), sorted by `receivedAt` then `responseId`.
  - rating: histogram of length `max` and average (null if none), rounded to 2 decimals.
- **Scoring.** Only when `isScoringQuestion(q)`. For each non-kicked player (initialise missing scoreboard entries with zeros):
  - correct → streak+1, `points = base + streakBonus(streak, m, settings.streakBonus)`
  - incorrect or no response → streak 0, points 0
  - `answeredScored++` if they responded, `correct++` if correct
  - `score += points`, `lastDelta = points`
  - Then rank all non-kicked players and set `lastRank`.
- **Non-scoring questions:** scores, streaks and ranks unchanged. `appliedThrough` still advances.
- **Outcomes.** `PlayerOutcome` per non-kicked player: `answered`, `correct` (scoring questions only), `points` (base), `streakBonus`, `score`, `rank`, `streak`.
- **Messages.** `playerMessages`: a `reveal` message per non-kicked player with `sv = new meta.version`, `result = toPlayerResult(hostResult)` and `you = outcome`.
- **Meta.** `phase 'reveal'`, version + 1. `stored.closedAt = meta.closedAt`, `computedAt = now`.
- **`revealFromStored`.** Same meta transition and messages, built from the stored result and outcomes. Kicked players get no message.

### Views

- `buildQuestionMessage`: `{type:'question', sv, index, total, question: toPublicQuestion(...), openAt, deadline}`.
- `buildLeaderboard`:
  - `entries` = top `LIMITS.leaderboardSize` by `rankEntries` among non-kicked players, with `delta = lastDelta`.
  - One player message each, with `you = {score, rank, behind?}`. `behind` is the nearest player with a strictly higher score: their nickname and the points gap.
- `buildEnded`:
  - `podium` = ranked entries with `rank ≤ LIMITS.podiumSize`, capped at `LIMITS.podiumSize` entries; empty if `!meta.hasScoredQuestions`.
  - Per player `FinalStanding`: `scoredQuestions` counts scoring questions that were revealed (not skipped, index ≤ the last revealed).
- `buildPlayerSnapshot` / `buildHostSnapshot`: fill exactly the fields the protocol schema documents for each phase.
  - The player snapshot's `question` field uses the public question.
  - The host snapshot includes the full question, `closedAt`, `result` (reveal phase), `leaderboard` (leaderboard phase: top 10) and `podium` (ended).
  - Output must pass the protocol's `PlayerSnapshot` / `HostSnapshot` `safeParse`; test this.
- `computeLiveStats`:
  - Same aggregation as the reveal, without correctness.
  - For open questions: responses sorted by (`receivedAt`, `responseId`), paged by an opaque `after` cursor (`${receivedAt}:${responseId}`, base64url-encoded), page size `LIMITS.statsResponsesPage`, `cursor` null when there are no more.
  - Must pass the `LiveStats` schema.

### CSV (`buildResultsCsv`)

- **Format.** RFC 4180 (CRLF line endings, quote fields containing `"`, `,`, CR or LF, and double embedded quotes). UTF-8 with a leading BOM so spreadsheet apps detect the encoding.
- **Formula injection.** Prefix `'` to any cell beginning with `=`, `+`, `-`, `@`, tab or CR.
- **Columns:** `question_no, question_type, question, nickname, player_id, answered, response, correct, points, streak_bonus, response_time_ms, moderation, final_score, final_rank`.
- **Rows.**
  - One row per (revealed question × non-kicked player), in question order then rank order.
  - Word cloud and open-ended produce one row per response; a player with no response gets one row with `answered=no`.
  - `response` renders the option text, `True`/`False`, the text, or the rating.
  - Skipped and unrevealed questions are omitted.

## Tests (Vitest, `packages/engine/test/*.test.ts`, `packages/protocol/test/*.test.ts`)

- **Protocol:** valid and invalid samples for every `ClientMessage` and `ServerMessage` type; `QuizInput` refinements (duplicate IDs, missing correct option, too many options, bad time limit); limits at their exact boundaries.
- **State machine:** table-driven over **every phase × every host command**, including stale `from`, wrong index, repeats, last question, skipped questions, and lock in each phase. Assert phase, index, timing fields, version and effect.
- **Scoring:** elapsed 0, 250, 251, midpoint, limit, beyond limit; untimed; m = 0/1/2; `limitMs ≤ 250`; rounding; streak bonus on/off at streaks 0-6.
- **Ranking:** ties, ordering stability, competition ranks (1,2,2,4).
- **Nicknames and text:** every rule above, including the listed examples, emoji grapheme counts, Zalgo, confusables and leet collisions, a profanity hit and a Scunthorpe-style false positive check (document the result).
- **Answers:** every reject reason, duplicate vs limit, slot allocation, `elapsedMs` clamping, correctness, status assignment.
- **Reveal:** each question type; kicked players excluded; a late joiner; streak bonus on and off; a non-scoring question keeps scores; the `appliedThrough` precondition; `revealFromStored` equivalence with `computeReveal`'s messages.
- **Secrecy:** for every question type, no player-bound message or snapshot built by the engine contains the correct answer before phase `reveal`.
- **Views:** snapshots and live stats validate against the protocol schemas in every phase; live-stats paging.
- **CSV:** escaping, BOM, formula injection, row counts.
- **Coverage:** `vitest run --coverage` with thresholds of ≥ 95% lines and ≥ 90% branches on `packages/engine/src`, configured in `packages/engine/vitest.config.ts`.

## Acceptance criteria

1. The public API above exists with these names and signatures and is exported from `src/index.ts`.
2. `pnpm --filter @zqhoot/engine typecheck`, `pnpm --filter @zqhoot/engine test` (with coverage thresholds) and `pnpm --filter @zqhoot/protocol test` all pass. So does `pnpm --filter @zqhoot/protocol typecheck`.
3. The engine source imports only `@zqhoot/protocol`, `obscenity` and its own files: no `node:` modules, no `Date.now`, no `Math.random`, no `crypto`. A test enforces this by scanning `src/`.
4. `pnpm exec prettier --check packages/engine packages/protocol` passes.
5. Comments explain non-obvious _why_ only.
