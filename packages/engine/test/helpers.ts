import { ServerMessage } from '@zqhoot/protocol';
import type {
  AnswerPayload,
  OutboundMessage,
  Question,
  Quiz,
  QuizSettings,
} from '@zqhoot/protocol';
import {
  DEFAULT_SESSION_TTL_MS,
  applyHostCommand,
  createSession,
  evaluateAnswer,
} from '../src/index.ts';
import type {
  EngineConfig,
  HostTransitionCommand,
  PlayerRecord,
  PlayerScore,
  QuizSnapshot,
  ResponseRecord,
  Scoreboard,
  SessionMeta,
} from '../src/index.ts';

export const CFG: EngineConfig = {
  minLeadMs: 750,
  answerGraceMs: 750,
  sessionTtlMs: DEFAULT_SESSION_TTL_MS,
};

export const SETTINGS: QuizSettings = {
  streakBonus: false,
  showQuestionOnDevices: true,
  readSeconds: 3,
};

export const opt = (id: string, text = id) => ({ id, text });

/** Indexes of the fixture quiz, so tests read as prose. */
export const Q = {
  single: 0,
  truefalse: 1,
  poll: 2,
  wordcloud: 3,
  open: 4,
  rating: 5,
  zeroPoints: 6,
  lastScored: 7,
} as const;

export function questions(): Question[] {
  return [
    {
      id: 'q-single',
      type: 'single',
      prompt: 'Capital of France?',
      timeLimitSec: 20,
      options: [opt('opt-paris', 'Paris'), opt('opt-rome', 'Rome'), opt('opt-oslo', 'Oslo')],
      correctOptionId: 'opt-paris',
      points: 1,
    },
    {
      id: 'q-truefalse',
      type: 'truefalse',
      prompt: 'The sky is green',
      timeLimitSec: 10,
      correct: false,
      points: 2,
    },
    {
      id: 'q-poll',
      type: 'poll',
      prompt: 'Favourite colour?',
      timeLimitSec: null,
      options: [opt('opt-red', 'Red'), opt('opt-blue', 'Blue')],
    },
    { id: 'q-wordcloud', type: 'wordcloud', prompt: 'One word', timeLimitSec: 30, maxEntries: 3 },
    {
      id: 'q-open',
      type: 'open',
      prompt: 'Tell us more',
      timeLimitSec: 60,
      maxEntries: 2,
      requireApproval: true,
    },
    {
      id: 'q-rating',
      type: 'rating',
      prompt: 'Rate it',
      timeLimitSec: 15,
      max: 5,
      minLabel: 'Bad',
      maxLabel: 'Great',
    },
    {
      id: 'q-zero',
      type: 'single',
      prompt: 'For fun',
      timeLimitSec: 20,
      options: [opt('opt-yes', 'Yes'), opt('opt-no', 'No')],
      correctOptionId: 'opt-yes',
      points: 0,
    },
    {
      id: 'q-last',
      type: 'truefalse',
      prompt: 'Last one',
      timeLimitSec: 20,
      correct: true,
      points: 1,
    },
  ];
}

export function quizOf(qs: Question[] = questions(), settings: Partial<QuizSettings> = {}): Quiz {
  return {
    id: 'quiz-0001',
    ownerId: 'host-0001',
    title: 'Fixture quiz',
    questions: qs,
    settings: { ...SETTINGS, ...settings },
    version: 1,
    createdAt: 1000,
    updatedAt: 1000,
  };
}

export const NOW = 1_000_000;

export function newSession(qs?: Question[], settings?: Partial<QuizSettings>) {
  return createSession({
    sessionId: 'sess-0001',
    pin: '123456',
    hostId: 'host-0001',
    quiz: quizOf(qs, settings),
    now: NOW,
    cfg: CFG,
  });
}

export type Cmd = HostTransitionCommand;

/** Applies commands in order, asserting each succeeds. */
export function drive(
  start: { meta: SessionMeta; snapshot: QuizSnapshot },
  cmds: Array<[Cmd, number]>,
): SessionMeta {
  let meta = start.meta;
  for (const [cmd, now] of cmds) {
    const r = applyHostCommand(meta, start.snapshot, cmd, now, CFG);
    if (!r.ok) throw new Error(r.message);
    meta = r.meta;
  }
  return meta;
}

export const next = (meta: SessionMeta): Cmd => ({
  type: 'host.next',
  from: { phase: meta.phase, questionIndex: meta.questionIndex },
});

export function player(n: number, over: Partial<PlayerRecord> = {}): PlayerRecord {
  const id = `player-${String(n).padStart(2, '0')}`;
  return {
    sessionId: 'sess-0001',
    playerId: id,
    nickname: `Player${n}`,
    nicknameKey: `playerl${n}`,
    tokenHash: 'hash',
    joinedAt: 100 + n,
    kicked: false,
    lastSeenAt: 100 + n,
    ...over,
  };
}

export const pid = (n: number) => `player-${String(n).padStart(2, '0')}`;

/** A meta in an arbitrary phase for state-machine tests (bypasses the transitions on purpose). */
export function metaIn(
  base: SessionMeta,
  phase: SessionMeta['phase'],
  questionIndex: number,
  over: Partial<SessionMeta> = {},
): SessionMeta {
  const hasTiming = phase === 'question' || phase === 'revealing' || phase === 'reveal';
  return {
    ...base,
    phase,
    questionIndex,
    version: 7,
    openAt: hasTiming ? NOW + 3000 : null,
    deadline: hasTiming ? NOW + 3000 + 20_000 : null,
    closedAt: phase === 'revealing' || phase === 'reveal' ? NOW + 10_000 : null,
    ...over,
  };
}

export function response(
  meta: SessionMeta,
  playerId: string,
  payload: AnswerPayload,
  over: Partial<ResponseRecord> = {},
): ResponseRecord {
  return {
    sessionId: meta.sessionId,
    questionIndex: meta.questionIndex,
    playerId,
    slot: 0,
    responseId: `${playerId}-0`,
    payload,
    receivedAt: NOW + 4000,
    elapsedMs: 1000,
    correct: null,
    points: 0,
    status: 'visible',
    ...over,
  };
}

/** Hand-computed 'question' meta, independent of the engine's own transition code. */
export function openAtIndex(
  s: { meta: SessionMeta; snapshot: QuizSnapshot },
  index: number,
  now = NOW,
): SessionMeta {
  const q = s.snapshot.questions[index];
  if (q === undefined) throw new Error('no such question');
  const openAt = now + Math.max(s.snapshot.settings.readSeconds * 1000, CFG.minLeadMs);
  const limit = q.timeLimitSec === null ? null : q.timeLimitSec * 1000;
  return {
    ...s.meta,
    phase: 'question',
    questionIndex: index,
    openAt,
    deadline: limit === null ? null : openAt + limit,
    closedAt: null,
    version: 2,
  };
}

/** Runs the answer evaluator and returns the accepted record (throws otherwise). */
export function accept(
  s: { meta: SessionMeta; snapshot: QuizSnapshot },
  meta: SessionMeta,
  playerId: string,
  payload: AnswerPayload,
  receivedAt: number,
  existing: ResponseRecord[] = [],
): ResponseRecord {
  const d = evaluateAnswer({
    meta,
    snapshot: s.snapshot,
    playerId,
    questionIndex: meta.questionIndex,
    payload,
    receivedAt,
    existing,
    cfg: CFG,
  });
  if (d.kind !== 'accept') throw new Error(`expected accept, got ${JSON.stringify(d)}`);
  return d.response;
}

/** Every outbound message must satisfy the wire schema once the transport adds `ts`. */
export function validServerMessage(message: OutboundMessage): boolean {
  const parsed = ServerMessage.safeParse({ ...message, ts: 1 });
  if (!parsed.success) console.error(JSON.stringify(parsed.error.issues, null, 2));
  return parsed.success;
}

/** The 'revealing' meta after question `index` was opened at NOW and closed 8 s later. */
export function revealingAt(
  s: { meta: SessionMeta; snapshot: QuizSnapshot },
  index: number,
): SessionMeta {
  const open = openAtIndex(s, index);
  return { ...open, phase: 'revealing', closedAt: (open.openAt as number) + 8000, version: 3 };
}

export function board(
  players: Record<string, Partial<PlayerScore>>,
  appliedThrough: number,
  version = 1,
): Scoreboard {
  return {
    sessionId: 'sess-0001',
    version,
    appliedThrough,
    players: Object.fromEntries(
      Object.entries(players).map(([id, s]) => [
        id,
        { score: 0, streak: 0, correct: 0, answeredScored: 0, lastDelta: 0, lastRank: null, ...s },
      ]),
    ),
  };
}
