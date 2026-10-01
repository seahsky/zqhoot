import { TIMING } from '@zqhoot/protocol';
import type { HostCloseMsg, HostStatsMsg, Question } from '@zqhoot/protocol';

/**
 * What a host client does by itself while a question is open (ADR-0006, ARCHITECTURE):
 * poll `host.stats` once a second starting when options open, and close the question when
 * the answer grace after the deadline is over or everybody has answered. On Lambda nothing
 * else closes a question, so both the presenter and the control run one of these; closing
 * twice is a no-op on the server, and so is a stale `questionIndex`. A close is only
 * believed once the snapshot leaves the question: until then it is sent again.
 *
 * Pure: it is fed inputs and returns commands. The container owns the clock (estimated server
 * time, `conn.clock.serverNow(Date.now())`, so `deadline <= now` is the spec's
 * `clock.toLocal(deadline) <= Date.now()`) and the socket.
 */

export interface DriverQuestion {
  index: number;
  /** Server time options open. */
  openAt: number;
  /** Server time answers stop; null for an untimed question. */
  deadline: number | null;
  /**
   * A word cloud or open-ended question that takes several entries per player: "everyone has
   * answered" only means everyone has sent their first one, so it must not close the question.
   */
  multiEntry: boolean;
}

/**
 * How often an open-ended question's whole list is read again from the first page.
 *
 * Between those walks a poller only asks for the pages after its last cursor, which is cheap
 * but never shows a change to an older response. The other window moderates through its own
 * connection and the server sends no notice, so without a re-walk a response the host hides
 * stays on the projector and one approved late never appears.
 */
export const REWALK_MS = 3 * TIMING.statsPollMs;

/** First wait before a `host.close` the server refused is sent again; it doubles up to the cap. */
export const CLOSE_RETRY_MS = TIMING.statsPollMs;
export const CLOSE_RETRY_MAX_MS = 8 * TIMING.statsPollMs;

/**
 * How long a sent `host.close` may go unanswered (the snapshot still in the question) before it
 * is presumed lost and sent again, doubling up to the cap. The server says nothing about a close
 * that died with a socket or an invocation, and on Lambda no one else would close the question.
 */
export const CLOSE_RESEND_MS = 3 * TIMING.statsPollMs;
export const CLOSE_RESEND_MAX_MS = 30 * TIMING.statsPollMs;

export interface DriverState {
  question: DriverQuestion | null;
  /**
   * Where an open-ended question's response list is being read from: the last non-null cursor,
   * or null to start at the first page. Only a list of more than one page ever sets it.
   */
  cursor: string | null;
  /** The last reply said more pages wait, so the next is asked for at once and no re-walk may cut in. */
  paging: boolean;
  /** Server time the list is next read again from its first page; only used while `cursor` is set. */
  rewalkAt: number;
  /** Server time the next `host.stats` is due. */
  nextPollAt: number;
  /**
   * A `host.close` is on its way: set when sent, cleared if the socket or the server refused it,
   * and once `closeResendAt` passes without the question ending.
   */
  closeSent: boolean;
  /** Closes sent for this question; sets how long the next one is waited for. */
  closeSends: number;
  /** Server time a close that got no answer counts as lost. */
  closeResendAt: number;
  /** Refusals by the server for this question; sets the backoff. */
  closeRefusals: number;
  /** Server time a refused close may be sent again. */
  closeRetryAt: number;
}

export type DriverInput =
  /** The current question, or null outside the question phase. Send on every snapshot. */
  | { type: 'sync'; question: DriverQuestion | null }
  | { type: 'tick' }
  /** A `stats` reply. `cursor` is only ever set for open-ended questions. */
  | {
      type: 'stats';
      questionIndex: number;
      answered: number;
      /** Every non-kicked player, connected or not. */
      totalPlayers: number;
      /**
       * The players the question waits for: those connected and those who already answered
       * (`LiveStats.expected`). "Everyone has answered" is measured against it. A server that does
       * not send it leaves it out, and `totalPlayers` stands in. The host session hook
       * (`screens/host/useHostSession.ts`) builds this input and must forward it; a test in
       * `driver.test.ts` fails when it does not, since the driver would silently fall back.
       */
      expected?: number;
      cursor: string | null;
    }
  /** `Connection.send()` returned false for this kind of command. */
  | { type: 'unsent'; command: 'close' | 'stats' }
  /**
   * The server answered a `host.close` with an error that may pass (`rate-limited`, `internal`,
   * `conflict`). Nothing else tells the driver, and it would never send another close.
   */
  | { type: 'close.refused' }
  /** Re-read every response from the first page now: after a reconnect or a refused moderation. */
  | { type: 'resync' };

export type DriverCommand = HostStatsMsg | HostCloseMsg;

export interface DriverResult {
  state: DriverState;
  commands: DriverCommand[];
}

export const IDLE_DRIVER: DriverState = {
  question: null,
  cursor: null,
  paging: false,
  rewalkAt: 0,
  nextPollAt: 0,
  closeSent: false,
  closeSends: 0,
  closeResendAt: 0,
  closeRefusals: 0,
  closeRetryAt: 0,
};

export function driverQuestionOf(
  q: Question,
  index: number,
  openAt: number,
  deadline: number | null,
) {
  const multiEntry = (q.type === 'wordcloud' || q.type === 'open') && q.maxEntries > 1;
  return { index, openAt, deadline, multiEntry } satisfies DriverQuestion;
}

function canClose(state: DriverState, now: number): boolean {
  return !state.closeSent && now >= state.closeRetryAt;
}

function withCloseSent(state: DriverState, now: number): DriverState {
  const sends = state.closeSends + 1;
  const wait = Math.min(CLOSE_RESEND_MAX_MS, CLOSE_RESEND_MS * 2 ** (sends - 1));
  return { ...state, closeSent: true, closeSends: sends, closeResendAt: now + wait };
}

export function driverStep(state: DriverState, input: DriverInput, now: number): DriverResult {
  switch (input.type) {
    case 'sync': {
      const q = input.question;
      if (q === null) return { state: state.question === null ? state : IDLE_DRIVER, commands: [] };
      if (state.question?.index === q.index) {
        return { state: { ...state, question: q }, commands: [] };
      }
      // Polling starts when options open: nobody can have answered before that.
      return {
        state: {
          question: q,
          cursor: null,
          paging: false,
          rewalkAt: 0,
          nextPollAt: q.openAt,
          closeSent: false,
          closeSends: 0,
          closeResendAt: 0,
          closeRefusals: 0,
          closeRetryAt: 0,
        },
        commands: [],
      };
    }

    case 'tick': {
      const q = state.question;
      if (q === null) return { state, commands: [] };
      // A close that has stood unanswered for its whole wait is treated as never sent.
      const s =
        state.closeSent && now >= state.closeResendAt ? { ...state, closeSent: false } : state;
      // The server takes answers until the grace is over, and an answer that reaches it after
      // the close is refused whatever its clock says, so closing at the bare deadline would
      // cost the players whose answer is still in flight (ADR-0005).
      if (canClose(s, now) && q.deadline !== null && now >= q.deadline + TIMING.answerGraceMs) {
        const close: HostCloseMsg = {
          type: 'host.close',
          questionIndex: q.index,
          reason: 'timer',
        };
        return { state: withCloseSent(s, now), commands: [close] };
      }
      // Once the close is on its way the next figures arrive with the result.
      if (s.closeSent || now < s.nextPollAt) return { state: s, commands: [] };
      // A re-walk is a poll from the first page; its replies then page on as usual, and `paging`
      // stops another one restarting a walk that is still under way.
      const rewalk = s.cursor !== null && !s.paging && now >= s.rewalkAt;
      const after = rewalk ? null : s.cursor;
      const poll: HostStatsMsg = {
        type: 'host.stats',
        questionIndex: q.index,
        ...(after !== null ? { after } : {}),
      };
      return {
        state: { ...s, cursor: after, nextPollAt: now + TIMING.statsPollMs },
        commands: [poll],
      };
    }

    case 'stats': {
      const q = state.question;
      if (q === null || input.questionIndex !== q.index) return { state, commands: [] };
      let next = state;
      if (input.cursor !== null) {
        // More pages wait behind this one: fetch the next at once instead of in a second.
        next = { ...next, cursor: input.cursor, paging: true, nextPollAt: now };
      } else if (state.paging) {
        // The walk reached the end; from here only the tail is polled, until the next re-walk.
        next = { ...next, paging: false, rewalkAt: now + REWALK_MS };
      }
      // ADR-0006: every connected, non-kicked player. A player who dropped out without answering
      // is not in `expected`, so a lost phone cannot hold the question open.
      const awaited = input.expected ?? input.totalPlayers;
      const everyoneAnswered = awaited > 0 && input.answered >= awaited && !q.multiEntry;
      if (everyoneAnswered && canClose(state, now)) {
        const close: HostCloseMsg = {
          type: 'host.close',
          questionIndex: q.index,
          reason: 'all-answered',
        };
        return { state: withCloseSent(next, now), commands: [close] };
      }
      return { state: next, commands: [] };
    }

    case 'unsent':
      // A lost poll is simply retried on schedule; a lost close must be retried, and a close
      // that never left the browser says nothing about how long the next one should be waited for.
      return {
        state:
          input.command === 'close'
            ? { ...state, closeSent: false, closeSends: Math.max(0, state.closeSends - 1) }
            : state,
        commands: [],
      };

    case 'close.refused': {
      // Only a close this driver sent can be retried; another window's refusal is not ours.
      if (state.question === null || !state.closeSent) return { state, commands: [] };
      const refusals = state.closeRefusals + 1;
      const wait = Math.min(CLOSE_RETRY_MAX_MS, CLOSE_RETRY_MS * 2 ** (refusals - 1));
      return {
        state: { ...state, closeSent: false, closeRefusals: refusals, closeRetryAt: now + wait },
        commands: [],
      };
    }

    case 'resync':
      if (state.question === null) return { state, commands: [] };
      // A reconnect: whatever was sent on the old socket may not have arrived, and the welcome
      // that follows says whether the question is still open. If it is, the next tick decides
      // again at once instead of waiting out the rest of the resend delay.
      return {
        state: { ...state, cursor: null, paging: false, nextPollAt: now, closeResendAt: 0 },
        commands: [],
      };
  }
}
