import type {
  AnswerAckMsg,
  AnswerPayload,
  AnswerRejectReason,
  ErrorMsg,
  FinalStanding,
  LeaderboardEntry,
  PlayerOutcome,
  PlayerSnapshot,
  PlayerStanding,
  PublicQuestion,
  QuestionResult,
  ServerMessage,
} from '@zqhoot/protocol';
import type { ConnectionStatus } from '../net/connection.ts';

// ---------------------------------------------------------------------------
// Copy for answers the server refused (or that never left the phone)
// ---------------------------------------------------------------------------

export type Notice = AnswerRejectReason | 'offline' | 'busy';

export const NOTICE_COPY: Record<Notice, string> = {
  'not-open': "This question isn't taking answers right now.",
  'too-early': "Options aren't open yet. Try again in a moment.",
  'too-late': 'Too late: this question has closed.',
  invalid: "That answer wasn't accepted. Try again.",
  limit: "You've used all your entries for this question.",
  offline: "You're offline, so your answer was not sent. Try again once you're reconnected.",
  busy: 'Slow down a little, then try again.',
};

// ---------------------------------------------------------------------------
// View model: what the player screens render
// ---------------------------------------------------------------------------

export interface PlayerProfile {
  playerId: string;
  nickname: string;
  score: number;
  rank: number | null;
  streak: number;
}

export interface QuestionInfo {
  /** Zero-based. */
  index: number;
  total: number;
  question: PublicQuestion;
  /** Server time. */
  openAt: number;
  /** Server time; null for untimed questions. */
  deadline: number | null;
}

export interface TimerInfo {
  /** Whole seconds, rounded up; null when untimed. */
  secondsLeft: number | null;
  /** 1 at opening down to 0 at the deadline; null when untimed. */
  fraction: number | null;
}

/**
 * Text the server refused, to put back into the entry field so the player does not have to
 * retype it. `seq` changes with every refusal, so the same text refused twice is still news.
 */
export interface DraftRestore {
  text: string;
  seq: number;
}

export type RevealVariant = 'correct' | 'incorrect' | 'unscored' | 'no-answer';

export interface CorrectAnswer {
  /** Answer slot 0-5, which fixes its letter, glyph and colour. */
  slot: number;
  text: string;
}

export type PlayerView =
  /** Before the first welcome. */
  | { screen: 'connecting' }
  | { screen: 'lobby' }
  /** Question shown, options inert until `openAt`. */
  | { screen: 'get-ready'; q: QuestionInfo; secondsUntilOpen: number }
  | {
      screen: 'answering';
      q: QuestionInfo;
      timer: TimerInfo;
      notice: string | null;
      restore?: DraftRestore;
    }
  /**
   * At least one response is in. `remaining` is how many more entries a word cloud or
   * open-ended question still accepts; it is 0 for every other type.
   */
  | {
      screen: 'submitted';
      q: QuestionInfo;
      timer: TimerInfo;
      responses: AnswerPayload[];
      remaining: number;
      /** An `answer` is on the wire and unacknowledged. */
      sending: boolean;
      notice: string | null;
      restore?: DraftRestore;
    }
  | { screen: 'times-up'; q: QuestionInfo; responses: AnswerPayload[]; notice: string | null }
  | {
      screen: 'reveal';
      index: number;
      total: number;
      variant: RevealVariant;
      outcome: PlayerOutcome;
      /** Base points plus streak bonus. */
      gained: number;
      correctAnswer: CorrectAnswer | null;
    }
  | { screen: 'leaderboard'; index: number; total: number; standing: PlayerStanding }
  | {
      screen: 'ended';
      podium: LeaderboardEntry[];
      totalPlayers: number;
      standing: FinalStanding;
    }
  | { screen: 'kicked' }
  | { screen: 'session-over'; reason: 'session-ended' | 'not-found' }
  /** The server refused this page's protocol version: only a reload can fix it. */
  | { screen: 'out-of-date' };

export type PlayerScreen = PlayerView['screen'];

export interface PlayerState {
  /** Highest session version applied; -1 before the first snapshot. */
  sv: number;
  /** Estimated server time, advanced by `tick` and by message timestamps; never goes backwards. */
  now: number;
  connection: ConnectionStatus;
  quizTitle: string;
  totalQuestions: number;
  me: PlayerProfile | null;
  view: PlayerView;
  /** Bookkeeping the view is derived from. Read `view`, not this. */
  stage: Stage;
}

// ---------------------------------------------------------------------------
// Internal model
// ---------------------------------------------------------------------------

interface QuestionRun {
  info: QuestionInfo;
  /** The server said answering is over (phase `revealing`, or a too-late/not-open rejection). */
  closed: boolean;
  /** Confirmed responses followed by `pending` optimistic ones. */
  responses: AnswerPayload[];
  pending: number;
  limitHit: boolean;
  notice: Notice | null;
  /** The last text entry the server refused, until the player sends again. */
  restoreText: string | null;
  /** Counts refusals for the whole run, and never resets, so `seq` is never reused. */
  restoreSeq: number;
}

type Stage =
  | { kind: 'connecting' }
  | { kind: 'lobby' }
  | { kind: 'question'; run: QuestionRun }
  | {
      kind: 'reveal';
      index: number;
      result: QuestionResult;
      outcome: PlayerOutcome;
      question: PublicQuestion | null;
    }
  | { kind: 'leaderboard'; index: number; standing: PlayerStanding }
  | { kind: 'ended'; podium: LeaderboardEntry[]; totalPlayers: number; standing: FinalStanding }
  | { kind: 'kicked' }
  | { kind: 'over'; reason: 'session-ended' | 'not-found' }
  | { kind: 'outdated' };

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

export type PlayerAction =
  | { type: 'message'; msg: ServerMessage }
  /** `now` is estimated *server* time: `connection.clock.serverNow(Date.now())`. */
  | { type: 'tick'; now: number }
  | { type: 'connection'; status: ConnectionStatus }
  /** The `answer` message was handed to the socket; lock the UI optimistically. */
  | { type: 'answer.sent'; index: number; payload: AnswerPayload }
  /** The socket was not open, so nothing was sent. */
  | { type: 'answer.unsent'; index: number };

export function initialPlayerState(connection: ConnectionStatus = 'idle'): PlayerState {
  return withView({
    sv: -1,
    now: 0,
    connection,
    quizTitle: '',
    totalQuestions: 0,
    me: null,
    stage: { kind: 'connecting' },
  });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export function isTextQuestion(
  q: PublicQuestion,
): q is Extract<PublicQuestion, { maxEntries: number }> {
  return q.type === 'wordcloud' || q.type === 'open';
}

/** How many responses a question takes from one player. */
export function entryLimit(q: PublicQuestion): number {
  return isTextQuestion(q) ? q.maxEntries : 1;
}

function timerFor(info: QuestionInfo, now: number): TimerInfo {
  if (info.deadline === null) return { secondsLeft: null, fraction: null };
  const remaining = Math.max(0, info.deadline - now);
  const span = Math.max(1, info.deadline - info.openAt);
  return { secondsLeft: Math.ceil(remaining / 1000), fraction: Math.min(1, remaining / span) };
}

export function revealVariant(o: PlayerOutcome): RevealVariant {
  if (!o.answered) return 'no-answer';
  if (o.correct === undefined) return 'unscored';
  return o.correct ? 'correct' : 'incorrect';
}

function correctAnswerOf(
  question: PublicQuestion | null,
  result: QuestionResult,
): CorrectAnswer | null {
  if (result.type === 'truefalse') {
    return { slot: result.correct ? 0 : 1, text: result.correct ? 'True' : 'False' };
  }
  if (result.type === 'single' && question?.type === 'single') {
    const i = question.options.findIndex((o) => o.id === result.correctOptionId);
    const option = question.options[i];
    return option ? { slot: i, text: option.text } : null;
  }
  return null;
}

function deriveView(s: Omit<PlayerState, 'view'>): PlayerView {
  const { stage, now } = s;
  switch (stage.kind) {
    case 'connecting':
      return { screen: 'connecting' };
    case 'lobby':
      return { screen: 'lobby' };
    case 'kicked':
      return { screen: 'kicked' };
    case 'over':
      return { screen: 'session-over', reason: stage.reason };
    case 'outdated':
      return { screen: 'out-of-date' };
    case 'leaderboard':
      return {
        screen: 'leaderboard',
        index: stage.index,
        total: s.totalQuestions,
        standing: stage.standing,
      };
    case 'ended':
      return {
        screen: 'ended',
        podium: stage.podium,
        totalPlayers: stage.totalPlayers,
        standing: stage.standing,
      };
    case 'reveal':
      return {
        screen: 'reveal',
        index: stage.index,
        total: s.totalQuestions,
        variant: revealVariant(stage.outcome),
        outcome: stage.outcome,
        gained: stage.outcome.points + stage.outcome.streakBonus,
        correctAnswer: correctAnswerOf(stage.question, stage.result),
      };
    case 'question': {
      const { run } = stage;
      const { info } = run;
      const notice = run.notice ? NOTICE_COPY[run.notice] : null;
      const restore: DraftRestore | undefined =
        run.restoreText === null ? undefined : { text: run.restoreText, seq: run.restoreSeq };
      if (run.closed || (info.deadline !== null && now > info.deadline)) {
        return { screen: 'times-up', q: info, responses: run.responses, notice };
      }
      if (run.responses.length > 0) {
        const remaining = run.limitHit
          ? 0
          : Math.max(0, entryLimit(info.question) - run.responses.length);
        return {
          screen: 'submitted',
          q: info,
          timer: timerFor(info, now),
          responses: run.responses,
          remaining,
          sending: run.pending > 0,
          notice,
          restore,
        };
      }
      if (now < info.openAt) {
        return {
          screen: 'get-ready',
          q: info,
          secondsUntilOpen: Math.max(1, Math.ceil((info.openAt - now) / 1000)),
        };
      }
      return { screen: 'answering', q: info, timer: timerFor(info, now), notice, restore };
    }
  }
}

function withView(s: Omit<PlayerState, 'view'>): PlayerState {
  return { ...s, view: deriveView(s) };
}

function newRun(info: QuestionInfo, closed = false, responses: AnswerPayload[] = []): QuestionRun {
  return {
    info,
    closed,
    responses,
    pending: 0,
    limitHit: false,
    notice: null,
    restoreText: null,
    restoreSeq: 0,
  };
}

function currentRun(s: PlayerState): QuestionRun | null {
  return s.stage.kind === 'question' ? s.stage.run : null;
}

function withRun(s: PlayerState, run: QuestionRun): PlayerState {
  return withView({ ...s, stage: { kind: 'question', run } });
}

// ---------------------------------------------------------------------------
// Reducer
// ---------------------------------------------------------------------------

/** Kicked, session-over and out-of-date are final: nothing the socket says afterwards can revive them. */
function isFinal(s: PlayerState): boolean {
  return s.stage.kind === 'kicked' || s.stage.kind === 'over' || s.stage.kind === 'outdated';
}

export function playerReducer(state: PlayerState, action: PlayerAction): PlayerState {
  switch (action.type) {
    case 'connection':
      return state.connection === action.status
        ? state
        : withView({ ...state, connection: action.status });

    case 'tick': {
      if (!Number.isFinite(action.now) || action.now <= state.now) return state;
      return withView({ ...state, now: action.now });
    }

    case 'answer.sent': {
      const run = currentRun(state);
      if (!run || run.info.index !== action.index) return state;
      const v = state.view;
      const open = v.screen === 'answering' || (v.screen === 'submitted' && v.remaining > 0);
      if (!open) return state;
      return withRun(state, {
        ...run,
        responses: [...run.responses, action.payload],
        pending: run.pending + 1,
        notice: null,
        restoreText: null,
      });
    }

    case 'answer.unsent': {
      const run = currentRun(state);
      if (!run || run.info.index !== action.index) return state;
      return withRun(state, { ...run, notice: 'offline' });
    }

    case 'message':
      return reduceMessage(state, action.msg);
  }
}

function reduceMessage(prev: PlayerState, msg: ServerMessage): PlayerState {
  if (isFinal(prev)) return prev;
  // Re-derived here so that a message that changes nothing else still moves the clock.
  const state = msg.ts > prev.now ? withView({ ...prev, now: msg.ts }) : prev;

  switch (msg.type) {
    case 'welcome':
      // A snapshot always wins over what we hold, even with a lower `sv`: a restarted
      // server may have rolled back by up to a second, and the snapshot is the truth.
      return msg.role === 'player' ? applySnapshot(state, msg.snapshot) : state;

    case 'question': {
      if (msg.sv < state.sv) return state;
      const info: QuestionInfo = {
        index: msg.index,
        total: msg.total,
        question: msg.question,
        openAt: msg.openAt,
        deadline: msg.deadline,
      };
      const held = currentRun(state);
      // The same question sent twice must not forget what we already answered.
      const run =
        held && held.info.index === info.index && held.info.question.id === info.question.id
          ? { ...held, info }
          : newRun(info);
      return withView({
        ...state,
        sv: msg.sv,
        totalQuestions: msg.total,
        stage: { kind: 'question', run },
      });
    }

    case 'reveal': {
      if (msg.sv < state.sv) return state;
      const held = currentRun(state);
      return withView({
        ...state,
        sv: msg.sv,
        me: state.me && {
          ...state.me,
          score: msg.you.score,
          rank: msg.you.rank,
          streak: msg.you.streak,
        },
        stage: {
          kind: 'reveal',
          index: msg.index,
          result: msg.result,
          outcome: msg.you,
          question: held && held.info.index === msg.index ? held.info.question : null,
        },
      });
    }

    case 'leaderboard': {
      if (msg.sv < state.sv) return state;
      return withView({
        ...state,
        sv: msg.sv,
        me: state.me && { ...state.me, score: msg.you.score, rank: msg.you.rank },
        stage: { kind: 'leaderboard', index: msg.index, standing: msg.you },
      });
    }

    case 'ended': {
      if (msg.sv < state.sv) return state;
      return withView({
        ...state,
        sv: msg.sv,
        me: state.me && { ...state.me, score: msg.you.score, rank: msg.you.rank },
        stage: {
          kind: 'ended',
          podium: msg.podium,
          totalPlayers: msg.totalPlayers,
          standing: msg.you,
        },
      });
    }

    case 'answer.ack':
      return reduceAck(state, msg);

    case 'kicked':
      return withView({ ...state, stage: { kind: 'kicked' } });

    case 'error':
      return reduceError(state, msg);

    default:
      // pong and the host-only messages.
      return state;
  }
}

function applySnapshot(state: PlayerState, snap: PlayerSnapshot): PlayerState {
  const me: PlayerProfile = { ...snap.you };
  let stage: Stage = { kind: 'lobby' };

  if ((snap.phase === 'question' || snap.phase === 'revealing') && snap.question) {
    const info: QuestionInfo = {
      index: snap.questionIndex,
      total: snap.totalQuestions,
      question: snap.question.question,
      openAt: snap.question.openAt,
      deadline: snap.question.deadline,
    };
    stage = {
      kind: 'question',
      run: newRun(info, snap.phase === 'revealing', snap.responses ?? []),
    };
  } else if (snap.phase === 'reveal' && snap.reveal) {
    stage = {
      kind: 'reveal',
      index: snap.questionIndex,
      result: snap.reveal.result,
      outcome: snap.reveal.you,
      question: null,
    };
  } else if (snap.phase === 'leaderboard' && snap.leaderboard) {
    stage = { kind: 'leaderboard', index: snap.questionIndex, standing: snap.leaderboard.you };
  } else if (snap.phase === 'ended' && snap.ended) {
    stage = {
      kind: 'ended',
      podium: snap.ended.podium,
      totalPlayers: snap.ended.totalPlayers,
      standing: snap.ended.you,
    };
  }

  return withView({
    ...state,
    sv: snap.sv,
    quizTitle: snap.quizTitle,
    totalQuestions: snap.totalQuestions,
    me,
    stage,
  });
}

function reduceAck(state: PlayerState, msg: AnswerAckMsg): PlayerState {
  const run = currentRun(state);
  if (!run || run.info.index !== msg.index) return state;

  if (msg.status === 'rejected') {
    const reason: AnswerRejectReason = msg.reason ?? 'invalid';
    return withRun(state, rejectOldestPending(run, reason));
  }

  // `duplicate` means the server already holds this response, which is what we wanted.
  const pending = Math.max(0, run.pending - 1);
  let responses = run.responses;
  if (pending === 0 && msg.entries > 0 && responses.length > msg.entries) {
    responses = responses.slice(0, msg.entries);
  }
  return withRun(state, { ...run, pending, responses });
}

function rejectOldestPending(run: QuestionRun, reason: Notice): QuestionRun {
  const responses = [...run.responses];
  let pending = run.pending;
  let refusedText: string | null = null;
  if (pending > 0) {
    // The socket is ordered, so the ack answers the oldest send still waiting.
    const [refused] = responses.splice(responses.length - pending, 1);
    pending -= 1;
    // The entry field was cleared when the text was sent; hand the text back so it is not lost.
    if (refused?.kind === 'text') refusedText = refused.text;
  }
  return {
    ...run,
    responses,
    pending,
    restoreText: refusedText ?? run.restoreText,
    restoreSeq: refusedText === null ? run.restoreSeq : run.restoreSeq + 1,
    notice: reason,
    limitHit: run.limitHit || reason === 'limit',
    closed: run.closed || reason === 'too-late' || reason === 'not-open',
  };
}

function reduceError(state: PlayerState, msg: ErrorMsg): PlayerState {
  switch (msg.code) {
    case 'kicked':
      return withView({ ...state, stage: { kind: 'kicked' } });
    case 'session-ended':
    case 'not-found':
      return withView({ ...state, stage: { kind: 'over', reason: msg.code } });
    case 'protocol-version':
      return withView({ ...state, stage: { kind: 'outdated' } });
    default: {
      // An `answer` the server could not even parse or that hit a rate limit never gets an ack.
      const run = currentRun(state);
      if (msg.ref === 'answer' && run && run.pending > 0) {
        return withRun(
          state,
          rejectOldestPending(run, msg.code === 'rate-limited' ? 'busy' : 'invalid'),
        );
      }
      return state;
    }
  }
}
