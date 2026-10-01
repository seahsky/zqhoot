// When the host closes a question, as pure functions: they need neither k6 nor a socket, so
// `node --test` covers them (test/close.test.js). host.js is the only caller.

/**
 * `TIMING.answerGraceMs` of `packages/protocol/src/limits.ts`: the server accepts answers up to
 * this long after the deadline. k6 cannot import the protocol package, so the test compares the two.
 */
export const ANSWER_GRACE_MS = 750;

/**
 * Milliseconds from `localNow` until the timer close is due. The close goes out at
 * `deadline + ANSWER_GRACE_MS` on the server's timeline, as the web driver does: a close that
 * commits earlier refuses the answers still in flight as too late (ADR-0005). `offset` is the
 * local clock minus the server's, by the offset rule (`ClockOffset`).
 */
export const timerCloseDelayMs = (deadline, offset, localNow) =>
  deadline + ANSWER_GRACE_MS + offset - localNow;

/**
 * Whether every player the question still waits for has answered (ADR-0006: every connected,
 * non-kicked player). `expected` counts them, and a server that does not report it leaves the host
 * with `totalPlayers`, which includes players who dropped out without answering.
 */
export const everyoneAnswered = (stats) => {
  const awaited = typeof stats.expected === 'number' ? stats.expected : stats.totalPlayers;
  return awaited > 0 && stats.answered >= awaited;
};
