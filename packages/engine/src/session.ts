import { LIMITS } from '@zqhoot/protocol';
import type {
  ErrorCode,
  HostCloseMsg,
  HostEndMsg,
  HostLockMsg,
  HostNextMsg,
  HostSkipMsg,
  Quiz,
} from '@zqhoot/protocol';
import type { EngineConfig } from './config.ts';
import type { QuizSnapshot, SessionMeta } from './model.ts';
import { isScoringQuestion, questionLimitMs } from './questions.ts';

export function createSession(i: {
  sessionId: string;
  pin: string;
  hostId: string;
  quiz: Quiz;
  now: number;
  cfg: EngineConfig;
  maxPlayers?: number;
}): { meta: SessionMeta; snapshot: QuizSnapshot } {
  // Quiz data is plain JSON, so a round trip is a complete deep copy.
  const questions: QuizSnapshot['questions'] = JSON.parse(JSON.stringify(i.quiz.questions));
  const settings: QuizSnapshot['settings'] = JSON.parse(JSON.stringify(i.quiz.settings));
  const meta: SessionMeta = {
    sessionId: i.sessionId,
    pin: i.pin,
    hostId: i.hostId,
    quizId: i.quiz.id,
    quizTitle: i.quiz.title,
    totalQuestions: questions.length,
    hasScoredQuestions: questions.some(isScoringQuestion),
    settings: { ...settings },
    phase: 'lobby',
    questionIndex: -1,
    openAt: null,
    deadline: null,
    closedAt: null,
    locked: false,
    maxPlayers: i.maxPlayers ?? LIMITS.maxPlayersDefault,
    skipped: [],
    version: 1,
    createdAt: i.now,
    expiresAt: i.now + i.cfg.sessionTtlMs,
    endedAt: null,
  };
  return { meta, snapshot: { quizId: i.quiz.id, title: i.quiz.title, questions, settings } };
}

export function isExpired(meta: SessionMeta, now: number): boolean {
  return meta.expiresAt <= now;
}

export type JoinCheck =
  | { ok: true }
  | { ok: false; code: 'not-found' | 'session-ended' | 'session-locked' | 'session-full' };

export function checkJoinable(
  meta: SessionMeta | null,
  playerCount: number,
  now: number,
): JoinCheck {
  if (meta === null || isExpired(meta, now)) return { ok: false, code: 'not-found' };
  if (meta.phase === 'ended') return { ok: false, code: 'session-ended' };
  if (meta.locked) return { ok: false, code: 'session-locked' };
  if (playerCount >= meta.maxPlayers) return { ok: false, code: 'session-full' };
  return { ok: true };
}

export type HostTransitionCommand =
  HostNextMsg | HostCloseMsg | HostSkipMsg | HostEndMsg | HostLockMsg;

export type TransitionEffect =
  | { kind: 'none' }
  | { kind: 'question-opened'; questionIndex: number }
  /** Phase is now `revealing`: the caller settles, then runs the reveal. */
  | { kind: 'closing'; questionIndex: number }
  /** Phase was already `revealing`: the caller re-runs the reveal. */
  | { kind: 'retry-reveal'; questionIndex: number }
  | { kind: 'leaderboard'; questionIndex: number }
  | { kind: 'ended' }
  | { kind: 'lock-changed'; locked: boolean };

export type TransitionResult =
  | { ok: true; meta: SessionMeta; effect: TransitionEffect }
  | { ok: false; code: ErrorCode; message: string };

const noop = (meta: SessionMeta): TransitionResult => ({
  ok: true,
  meta,
  effect: { kind: 'none' },
});

/** Every state change goes through here so `version` cannot be forgotten. */
function next(meta: SessionMeta, changes: Partial<SessionMeta>, effect: TransitionEffect) {
  return { ok: true as const, meta: { ...meta, ...changes, version: meta.version + 1 }, effect };
}

const NO_TIMING = { openAt: null, deadline: null, closedAt: null } as const;

function end(meta: SessionMeta, now: number): TransitionResult {
  return next(meta, { phase: 'ended', endedAt: now, ...NO_TIMING }, { kind: 'ended' });
}

function openQuestion(
  meta: SessionMeta,
  snapshot: QuizSnapshot,
  index: number,
  now: number,
  cfg: EngineConfig,
  skipped: number[] = meta.skipped,
): TransitionResult {
  const q = snapshot.questions[index];
  if (q === undefined) return end({ ...meta, skipped }, now);
  const openAt = now + Math.max(snapshot.settings.readSeconds * 1000, cfg.minLeadMs);
  const limit = questionLimitMs(q);
  return next(
    meta,
    {
      phase: 'question',
      questionIndex: index,
      openAt,
      deadline: limit === null ? null : openAt + limit,
      closedAt: null,
      skipped,
    },
    { kind: 'question-opened', questionIndex: index },
  );
}

function closeQuestion(meta: SessionMeta, questionIndex: number, now: number): TransitionResult {
  if (meta.phase !== 'question' || meta.questionIndex !== questionIndex) return noop(meta);
  return next(meta, { phase: 'revealing', closedAt: now }, { kind: 'closing', questionIndex });
}

function advance(
  meta: SessionMeta,
  snapshot: QuizSnapshot,
  now: number,
  cfg: EngineConfig,
): TransitionResult {
  const index = meta.questionIndex;
  switch (meta.phase) {
    case 'lobby':
      return openQuestion(meta, snapshot, 0, now, cfg);
    case 'question':
      return closeQuestion(meta, index, now);
    case 'revealing':
      return { ok: true, meta, effect: { kind: 'retry-reveal', questionIndex: index } };
    case 'reveal': {
      const q = snapshot.questions[index];
      if (q !== undefined && isScoringQuestion(q)) {
        return next(
          meta,
          { phase: 'leaderboard', ...NO_TIMING },
          { kind: 'leaderboard', questionIndex: index },
        );
      }
      return openQuestion(meta, snapshot, index + 1, now, cfg);
    }
    case 'leaderboard':
      return openQuestion(meta, snapshot, index + 1, now, cfg);
    case 'ended':
      return noop(meta);
  }
}

export function applyHostCommand(
  meta: SessionMeta,
  snapshot: QuizSnapshot,
  cmd: HostTransitionCommand,
  now: number,
  cfg: EngineConfig,
): TransitionResult {
  switch (cmd.type) {
    case 'host.next':
      if (cmd.from.phase !== meta.phase || cmd.from.questionIndex !== meta.questionIndex) {
        return noop(meta);
      }
      return advance(meta, snapshot, now, cfg);
    case 'host.close':
      return closeQuestion(meta, cmd.questionIndex, now);
    case 'host.skip':
      if (meta.phase !== 'question' || meta.questionIndex !== cmd.questionIndex) return noop(meta);
      return openQuestion(meta, snapshot, meta.questionIndex + 1, now, cfg, [
        ...meta.skipped,
        meta.questionIndex,
      ]);
    case 'host.end':
      return meta.phase === 'ended' ? noop(meta) : end(meta, now);
    case 'host.lock':
      if (meta.phase === 'ended' || meta.locked === cmd.locked) return noop(meta);
      return next(meta, { locked: cmd.locked }, { kind: 'lock-changed', locked: cmd.locked });
    default:
      return {
        ok: false,
        code: 'bad-request',
        message: `not a session transition: ${(cmd as { type: string }).type}`,
      };
  }
}

/** VM timer expiry; same as host.close {reason:'timer'} for `questionIndex`. */
export function timerClose(
  meta: SessionMeta,
  questionIndex: number,
  now: number,
): TransitionResult {
  return closeQuestion(meta, questionIndex, now);
}
