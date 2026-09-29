/**
 * Wire protocol major version. Bump on any breaking change to a message schema;
 * servers reject clients whose `v` differs (see ADR-0004).
 */
export const PROTOCOL_VERSION = 1 as const;

export const LIMITS = {
  pinLength: 6,
  nicknameMinGraphemes: 2,
  nicknameMaxGraphemes: 16,
  /** Raw nickname input cap before normalisation; normalisation may shorten it. */
  nicknameRawMaxLength: 64,
  /**
   * Cap on the normalised nickname in UTF-8 bytes, on top of the grapheme and raw-length caps,
   * which do not bound bytes: 16 graphemes of Indic conjuncts reach 192 bytes and 16 flags reach
   * 128. The host roster (`host.state`, host `welcome`) carries every nickname, and 500 players
   * at the larger sizes overrun API Gateway's 128 KB message limit. 96 bytes still fits a full
   * name in any script ('लक्ष्मी शर्मा' is 37 bytes); 12 flags is the emoji ceiling.
   */
  nicknameMaxBytes: 96,
  quizTitleMax: 120,
  questionPromptMax: 200,
  optionTextMax: 80,
  choiceOptionsMin: 2,
  choiceOptionsMax: 4,
  pollOptionsMax: 6,
  questionsMax: 100,
  wordMaxLength: 25,
  wordEntriesMax: 5,
  openTextMax: 200,
  openEntriesMax: 3,
  ratingMaxMin: 3,
  ratingMaxMax: 10,
  ratingLabelMax: 40,
  /** Text alternative of a question's picture (`imageAlt`), in characters. */
  imageAltMax: 150,
  readSecondsMax: 10,
  maxPlayersDefault: 500,
  /** Hard cap for any client->server WebSocket message, in UTF-8 bytes. */
  clientMessageMaxBytes: 4096,
  imageMaxBytes: 5 * 1024 * 1024,
  leaderboardSize: 5,
  podiumSize: 3,
  wordCloudTopN: 60,
  statsResponsesPage: 100,
  /**
   * Most visible open-ended responses a host result carries (the newest). Keeps `host.state`,
   * the presenter's reveal and the stored result inside API Gateway's 128 KB message limit.
   */
  openRevealMax: 100,
} as const;

/** Allowed per-question time limits in seconds. `null` means untimed (host closes). */
export const TIME_LIMITS_SEC = [5, 10, 15, 20, 30, 45, 60, 90, 120, 180, 240] as const;

export const IMAGE_CONTENT_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'] as const;
export type ImageContentType = (typeof IMAGE_CONTENT_TYPES)[number];

export const TIMING = {
  /**
   * Minimum gap between broadcasting a question and opening it for answers.
   * Covers fan-out spread so the first and last recipient see options at the same
   * instant (ADR-0005). Lambda fan-out of 400 is ~0.2-0.8 s, so its floor is higher.
   */
  minLeadMs: { lambda: 1500, node: 750 },
  /** Answers received up to this long after the deadline are accepted (uplink latency). */
  answerGraceMs: 750,
  /** Correct answers inside this window after opening score full points. */
  fullPointsWindowMs: 250,
  /** Clients send `ping` after this long without any server message. */
  heartbeatIdleMs: 45_000,
  /** Clients reconnect if no `pong` arrives within this time. */
  pongTimeoutMs: 10_000,
  /** API Gateway closes connections after 2 h; clients reconnect before that. */
  plannedReconnectMs: 110 * 60_000,
  /** Host clients poll live stats at this interval while a question is open. */
  statsPollMs: 1000,
  reconnectBaseMs: 500,
  reconnectCapMs: 10_000,
} as const;

export const SCORING = {
  basePoints: 1000,
  /** A correct answer at the deadline keeps this fraction of the base. */
  minFraction: 0.4,
  streakBonusStep: 100,
  streakBonusMaxSteps: 3,
} as const;
