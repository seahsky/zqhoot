import { Counter, Rate, Trend } from 'k6/metrics';
import { MESSAGE_TYPES } from './ledger.js';

// ADR-0014 metrics. The names and definitions are the contract of docs/tasks/P5-load.md.

/** `welcome` received after `join`, one observation per join attempt. */
export const joinSuccess = new Rate('zq_join_success');
/** `welcome` received after `resume`, one observation per attempt. */
export const resumeSuccess = new Rate('zq_resume_success');
/**
 * Messages owed to a player and messages that arrived, per type. Settled once per player when its
 * game ends, so messages inside a closed disconnect window are in `zq_msg_missed_while_disconnected`
 * and in neither of these (see ledger.js).
 */
export const msgExpected = new Counter('zq_msg_expected');
export const msgReceived = new Counter('zq_msg_received');
export const msgMissedWhileDisconnected = new Counter('zq_msg_missed_while_disconnected');
/** Extras that keep the accounting auditable. */
export const msgDuplicate = new Counter('zq_msg_duplicate');
export const msgViaSnapshot = new Counter('zq_msg_via_snapshot');
/** Local receipt time minus the message `ts`, for question, reveal, leaderboard and ended. */
export const broadcastLatency = new Trend('zq_broadcast_latency_ms', true);
/** Milliseconds from sending `answer` to its `answer.ack`. */
export const answerAck = new Trend('zq_answer_ack_ms', true);
/**
 * `accepted` or `duplicate` (1) against `rejected` (0), one observation per answer that was sent or
 * was due to be sent: its acknowledgement, or the reveal's `you.answered` when the ack died with a
 * dropped socket. An answer that never got an outcome (no ack on a socket that stayed open, or a
 * resume that never succeeded) counts as 0. An answer the question outran (`answer-skipped`: the
 * player was still offline when the question ended) counts as neither.
 */
export const answerAccepted = new Rate('zq_answer_accepted');
export const errors = new Counter('zq_errors');
/**
 * How long before `openAt` (in the player's own clock, by the offset rule) a question arrived.
 * Below zero means the question reached the phone after its options should have opened, which is
 * what the minimum lead of ADR-0005 exists to prevent.
 */
export const questionMargin = new Trend('zq_question_margin_ms', true);
/** Host side: milliseconds from a command to the `host.state` that shows its effect. */
export const hostTransition = new Trend('zq_host_transition_ms', true);
/** Host side: from the host's `welcome` until the room was full (or the join timeout hit). */
export const joinPhase = new Trend('zq_join_phase_ms', true);

/** Host transitions, tagged `step`. */
export const HOST_STEPS = ['open-first', 'open-next', 'close-reveal', 'reveal-leaderboard', 'end'];

/** Error codes worth a line of their own in the report; anything else is only in the total. */
export const ERROR_CODES = [
  // The protocol's ErrorCode enum, as sent by the server.
  'bad-request',
  'protocol-version',
  'unauthorized',
  'forbidden',
  'not-found',
  'session-ended',
  'session-locked',
  'session-full',
  'nickname-invalid',
  'nickname-taken',
  'kicked',
  'rate-limited',
  'conflict',
  'internal',
  // Raised by the script.
  'http-lookup',
  'not-joinable',
  'ws-error',
  'ws-closed',
  'welcome-timeout',
  'ack-timeout',
  'answer-rejected-not-open',
  'answer-rejected-too-early',
  'answer-rejected-too-late',
  'answer-rejected-invalid',
  'answer-rejected-limit',
  'answer-skipped',
  'answer-undelivered',
  'answer-lost',
  'player-timeout',
  'join-timeout',
  'host-timeout',
  'host-closed',
];

export const recordError = (code, extra = {}) => errors.add(1, { code, ...extra });

// k6 lists a tagged sub-metric in the end-of-test summary only when a threshold names it. Those
// thresholds always pass; they exist to surface the per-type and per-code series. The two gates
// (join success and answer acceptance) are the only ones that can fail a run.
const surface = (name, tags, expression) => ({ [`${name}{${tags}}`]: [expression] });

export function buildThresholds(questions) {
  const thresholds = {
    // Gates: a miss makes k6 exit non-zero.
    zq_join_success: ['rate>0.995'],
    zq_answer_accepted: ['rate>0.99'],
  };
  for (const type of MESSAGE_TYPES) {
    Object.assign(
      thresholds,
      surface('zq_broadcast_latency_ms', `type:${type}`, 'max>=-1e9'),
      surface('zq_msg_expected', `type:${type}`, 'count>=0'),
      surface('zq_msg_received', `type:${type}`, 'count>=0'),
      surface('zq_msg_missed_while_disconnected', `type:${type}`, 'count>=0'),
    );
  }
  for (const step of HOST_STEPS) {
    Object.assign(thresholds, surface('zq_host_transition_ms', `step:${step}`, 'max>=-1e9'));
    // One series per question, for the timeline of every transition.
    for (let q = 0; q < questions; q++) {
      Object.assign(
        thresholds,
        surface('zq_host_transition_ms', `step:${step},q:${q}`, 'max>=-1e9'),
      );
    }
  }
  for (const code of ERROR_CODES) {
    Object.assign(thresholds, surface('zq_errors', `code:${code}`, 'count>=0'));
  }
  return thresholds;
}
