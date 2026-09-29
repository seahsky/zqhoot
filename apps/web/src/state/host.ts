import type {
  ErrorCode,
  HostSnapshot,
  LiveStats,
  ModerationStatus,
  OpenResponseView,
  RosterEntry,
  ServerMessage,
} from '@zqhoot/protocol';
import type { ConnectionStatus } from '../net/connection.ts';

/**
 * State of one host connection, control or presenter: the same protocol messages feed both
 * (`welcome`, `host.state`, `roster`, `stats`, `error`), so they share this reducer. It is pure;
 * time-based behaviour (countdowns, polling, auto-close) lives in `presenterView.ts` and
 * `driver.ts`, which read this state.
 */

/** A refused command or a lost connection the host should hear about, without leaving the screen. */
export interface HostNotice {
  code: ErrorCode | 'offline';
  message: string;
  /** Type of the client message that caused it, if the server said. */
  ref?: string;
  /** Changes with every notice, so the same text twice is still announced. */
  seq: number;
}

/** After one of these nothing the socket says can change the screen. */
export type HostEnd = 'session-ended' | 'not-found' | 'unauthorized' | 'out-of-date';

export interface LiveState {
  questionIndex: number;
  questionId: string;
  /** Latest reply to `host.stats`; null until the first one. */
  stats: LiveStats | null;
  /** Open-ended responses of every status, oldest first, merged across pages. */
  responses: readonly OpenResponseView[];
}

export interface HostState {
  /** Highest session version applied; -1 before the first snapshot. */
  sv: number;
  connection: ConnectionStatus;
  snapshot: HostSnapshot | null;
  /** Arrival order, oldest first. */
  roster: readonly RosterEntry[];
  /** Live figures for the open question; null in every other phase. */
  live: LiveState | null;
  notice: HostNotice | null;
  /** Incremented when the server refuses a moderation, so the poller re-reads real statuses. */
  moderationFailures: number;
  /** Incremented when the server refuses a `host.close` for a reason that may pass, so the driver sends it again. */
  closeRefusals: number;
  ended: HostEnd | null;
}

export type HostAction =
  | { type: 'message'; msg: ServerMessage }
  | { type: 'connection'; status: ConnectionStatus }
  /** The host pressed Show or Hide; the server sends no ack, so the list updates at once. */
  | {
      type: 'moderated';
      responseId: string;
      status: Extract<ModerationStatus, 'visible' | 'hidden'>;
    }
  /** `Connection.send()` returned false: nothing left the browser. */
  | { type: 'send.failed'; what: string }
  | { type: 'notice.dismiss' }
  /** A new connection after a refreshed sign-in: forget the refused state and start over. */
  | { type: 'reset'; connection: ConnectionStatus };

export function initialHostState(connection: ConnectionStatus = 'idle'): HostState {
  return {
    sv: -1,
    connection,
    snapshot: null,
    roster: [],
    live: null,
    notice: null,
    moderationFailures: 0,
    closeRefusals: 0,
    ended: null,
  };
}

export const HOST_NOTICE_COPY: Partial<Record<ErrorCode, string>> = {
  'rate-limited': 'Slow down a little, then try again.',
  conflict: 'That changed while you were pressing it. Check the screen and try again.',
  'bad-request': "The server didn't understand that command.",
  internal: 'The server had a problem. Try again in a moment.',
};

function isFinal(s: HostState): boolean {
  return s.ended !== null;
}

/** Live figures belong to one question; a different question (or none) starts them afresh. */
function liveFor(prev: LiveState | null, snap: HostSnapshot): LiveState | null {
  if (snap.phase !== 'question' || !snap.question) return null;
  const { question } = snap.question;
  if (prev && prev.questionIndex === snap.questionIndex && prev.questionId === question.id) {
    return prev;
  }
  return { questionIndex: snap.questionIndex, questionId: question.id, stats: null, responses: [] };
}

function byArrival(a: OpenResponseView, b: OpenResponseView): number {
  if (a.receivedAt !== b.receivedAt) return a.receivedAt - b.receivedAt;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/** Pages overlap (a poller resumes from its last cursor), so merge by id; the server's status wins. */
function mergeResponses(
  held: readonly OpenResponseView[],
  incoming: readonly OpenResponseView[],
): readonly OpenResponseView[] {
  if (incoming.length === 0) return held;
  const byId = new Map(held.map((r) => [r.id, r]));
  for (const r of incoming) byId.set(r.id, r);
  return [...byId.values()].sort(byArrival);
}

function applySnapshot(state: HostState, snap: HostSnapshot): HostState {
  return {
    ...state,
    sv: snap.sv,
    snapshot: snap,
    roster: snap.roster,
    live: liveFor(state.live, snap),
  };
}

function upsertRoster(
  roster: readonly RosterEntry[],
  upsert: readonly RosterEntry[],
  removed: readonly string[],
): readonly RosterEntry[] {
  // A Map keeps a key's first position when it is set again, so returning players stay
  // where they were and new ones go to the end.
  const byId = new Map(roster.map((r) => [r.playerId, r]));
  for (const entry of upsert) byId.set(entry.playerId, entry);
  for (const id of removed) byId.delete(id);
  return [...byId.values()];
}

function withNotice(state: HostState, notice: Omit<HostNotice, 'seq'>): HostState {
  return { ...state, notice: { ...notice, seq: (state.notice?.seq ?? 0) + 1 } };
}

export function hostReducer(state: HostState, action: HostAction): HostState {
  switch (action.type) {
    case 'connection':
      return state.connection === action.status ? state : { ...state, connection: action.status };

    case 'notice.dismiss':
      return state.notice === null ? state : { ...state, notice: null };

    case 'reset':
      return initialHostState(action.connection);

    case 'send.failed':
      return withNotice(state, {
        code: 'offline',
        message: `You're offline, so "${action.what}" was not sent. Try again once you're reconnected.`,
      });

    case 'moderated': {
      const live = state.live;
      if (!live) return state;
      return {
        ...state,
        live: {
          ...live,
          responses: live.responses.map((r) =>
            r.id === action.responseId ? { ...r, status: action.status } : r,
          ),
        },
      };
    }

    case 'message':
      return isFinal(state) ? state : reduceMessage(state, action.msg);
  }
}

function reduceMessage(state: HostState, msg: ServerMessage): HostState {
  switch (msg.type) {
    case 'welcome':
      // A snapshot always wins, even with a lower `sv`: a restarted server may have rolled
      // back by up to a second, and the snapshot is the truth.
      return msg.role === 'host' ? applySnapshot(state, msg.snapshot) : state;

    case 'host.state':
      if (msg.snapshot.sv < state.sv) return state;
      return applySnapshot(state, msg.snapshot);

    case 'roster':
      if (!state.snapshot) return state;
      return { ...state, roster: upsertRoster(state.roster, msg.upsert, msg.removed) };

    case 'stats': {
      const live = state.live;
      if (!live || msg.questionIndex !== live.questionIndex) return state;
      const responses =
        msg.stats.type === 'open'
          ? mergeResponses(live.responses, msg.stats.responses)
          : live.responses;
      return { ...state, live: { ...live, stats: msg.stats, responses } };
    }

    case 'error':
      return reduceError(state, msg);

    default:
      // pong and the player-only messages.
      return state;
  }
}

function reduceError(state: HostState, msg: Extract<ServerMessage, { type: 'error' }>): HostState {
  switch (msg.code) {
    case 'unauthorized':
    case 'forbidden':
      return { ...state, ended: 'unauthorized' };
    case 'session-ended':
    case 'not-found':
      return { ...state, ended: msg.code };
    case 'protocol-version':
      return { ...state, ended: 'out-of-date' };
    default: {
      const next = withNotice(state, {
        code: msg.code,
        message: HOST_NOTICE_COPY[msg.code] ?? msg.message,
        ...(msg.ref !== undefined ? { ref: msg.ref } : {}),
      });
      if (msg.ref === 'host.moderate') {
        return { ...next, moderationFailures: next.moderationFailures + 1 };
      }
      // `bad-request` would only fail again.
      if (msg.ref === 'host.close' && msg.code !== 'bad-request') {
        return { ...next, closeRefusals: next.closeRefusals + 1 };
      }
      return next;
    }
  }
}

// ---------------------------------------------------------------------------
// Selectors
// ---------------------------------------------------------------------------

/** Every non-kicked player the server lists. */
export function playerCount(state: HostState): number {
  return state.roster.length;
}

export function connectedCount(state: HostState): number {
  return state.roster.reduce((n, r) => n + (r.connected ? 1 : 0), 0);
}
