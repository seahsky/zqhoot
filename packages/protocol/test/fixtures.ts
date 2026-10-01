import type { HostSnapshot, PlayerSnapshot } from '../src/index.ts';

export const SID = 'sess-0001';
export const PID = 'player-01';
export const OPT_A = 'opt-alpha';
export const OPT_B = 'opt-beta';

export const publicQuestion = {
  id: 'q-single',
  type: 'single' as const,
  prompt: 'Capital of France?',
  timeLimitSec: 20,
  options: [
    { id: OPT_A, text: 'Paris' },
    { id: OPT_B, text: 'Rome' },
  ],
  points: 1 as const,
};

export const fullQuestion = {
  id: 'q-single',
  type: 'single' as const,
  prompt: 'Capital of France?',
  timeLimitSec: 20,
  options: [
    { id: OPT_A, text: 'Paris' },
    { id: OPT_B, text: 'Rome' },
  ],
  correctOptionId: OPT_A,
  points: 1 as const,
};

export const settings = { streakBonus: false, showQuestionOnDevices: true, readSeconds: 3 };

export const singleResult = {
  type: 'single' as const,
  answered: 3,
  totalPlayers: 4,
  correctOptionId: OPT_A,
  counts: { [OPT_A]: 2, [OPT_B]: 1 },
};

export const outcome = {
  answered: true,
  correct: true,
  points: 900,
  streakBonus: 0,
  score: 900,
  rank: 1,
  streak: 1,
};

export const entry = { playerId: PID, nickname: 'Ana', score: 900, rank: 1, delta: 900 };

export const playerSnapshot: PlayerSnapshot = {
  sv: 3,
  sessionId: SID,
  quizTitle: 'Geography',
  phase: 'question',
  questionIndex: 0,
  totalQuestions: 5,
  you: { playerId: PID, nickname: 'Ana', score: 0, rank: null, streak: 0 },
  question: { question: publicQuestion, openAt: 1_700_000_003_000, deadline: 1_700_000_023_000 },
  responses: [{ kind: 'choice', optionId: OPT_A }],
};

/** A player who resumed in the reveal phase of the single-choice question. */
export const revealSnapshot: PlayerSnapshot = {
  sv: 5,
  sessionId: SID,
  quizTitle: 'Geography',
  phase: 'reveal',
  questionIndex: 0,
  totalQuestions: 5,
  you: { playerId: PID, nickname: 'Ana', score: 900, rank: 1, streak: 1 },
  responses: [{ kind: 'choice', optionId: OPT_A }],
  reveal: { result: singleResult, you: outcome, question: publicQuestion },
};

export const hostSnapshot: HostSnapshot = {
  sv: 3,
  sessionId: SID,
  pin: '123456',
  quizId: 'quiz-0001',
  quizTitle: 'Geography',
  settings,
  phase: 'question',
  questionIndex: 0,
  totalQuestions: 5,
  locked: false,
  roster: [{ playerId: PID, nickname: 'Ana', connected: true }],
  question: {
    question: fullQuestion,
    openAt: 1_700_000_003_000,
    deadline: 1_700_000_023_000,
    closedAt: null,
  },
  hasScoredQuestions: true,
};
