import { TIMING } from '@zqhoot/protocol';
import type { HostCloseMsg, HostStatsMsg, Question } from '@zqhoot/protocol';

/**
 * What a host client does by itself while a question is open (ADR-0006, ARCHITECTURE):
 * poll `host.stats` once a second starting when options open, and close the question when
 * the deadline passes or everybody has answered. On Lambda nothing else closes a question,
 * so both the presenter and the control run one of these; closing twice is a no-op on the
 * server, and so is a stale `questionIndex`.
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
  /** One `host.close` per question: set when sent, cleared if the socket or the server refused it. */
  closeSent: boolean;
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
      totalPlayers: number;
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
          closeRefusals: 0,
          closeRetryAt: 0,
        },
        commands: [],
      };
    }

    case 'tick': {
      const q = state.question;
      if (q === null) return { state, commands: [] };
      if (canClose(state, now) && q.deadline !== null && now >= q.deadline) {
        const close: HostCloseMsg = {
          type: 'host.close',
          questionIndex: q.index,
          reason: 'timer',
        };
        return { state: { ...state, closeSent: true }, commands: [close] };
      }
      // Once the close is on its way the next figures arrive with the result.
      if (state.closeSent || now < state.nextPollAt) return { state, commands: [] };
      // A re-walk is a poll from the first page; its replies then page on as usual, and `paging`
      // stops another one restarting a walk that is still under way.
      const rewalk = state.cursor !== null && !state.paging && now >= state.rewalkAt;
      const after = rewalk ? null : state.cursor;
      const poll: HostStatsMsg = {
        type: 'host.stats',
        questionIndex: q.index,
        ...(after !== null ? { after } : {}),
      };
      return {
        state: { ...state, cursor: after, nextPollAt: now + TIMING.statsPollMs },
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
      const everyoneAnswered =
        input.totalPlayers > 0 && input.answered >= input.totalPlayers && !q.multiEntry;
      if (everyoneAnswered && canClose(state, now)) {
        const close: HostCloseMsg = {
          type: 'host.close',
          questionIndex: q.index,
          reason: 'all-answered',
        };
        return { state: { ...next, closeSent: true }, commands: [close] };
      }
      return { state: next, commands: [] };
    }

    case 'unsent':
      // A lost poll is simply retried on schedule; a lost close must be retried.
      return {
        state: input.command === 'close' ? { ...state, closeSent: false } : state,
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
      return { state: { ...state, cursor: null, paging: false, nextPollAt: now }, commands: [] };
  }
}
