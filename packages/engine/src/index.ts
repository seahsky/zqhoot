// Named re-exports on purpose: helpers such as `sanitize`, `nicknameKey` or `EMPTY_SCORE` stay
// internal so the service layer cannot start depending on them. Add a name here to make it API.
export * from './model.ts';
export { DEFAULT_SESSION_TTL_MS } from './config.ts';
export type { EngineConfig } from './config.ts';
export { normalizeNickname } from './nickname.ts';
export type { NicknameResult } from './nickname.ts';
export { containsProfanity, normalizeOpenText, normalizeWord } from './text.ts';
export { isScoringQuestion, questionLimitMs, toPublicQuestion } from './questions.ts';
export { basePoints, rankEntries, streakBonus } from './scoring.ts';
export {
  applyHostCommand,
  checkJoinable,
  createSession,
  isExpired,
  timerClose,
} from './session.ts';
export type {
  HostTransitionCommand,
  JoinCheck,
  TransitionEffect,
  TransitionResult,
} from './session.ts';
export { evaluateAnswer } from './answers.ts';
export type { AnswerDecision } from './answers.ts';
export { computeReveal, revealFromStored, toPlayerResult } from './reveal.ts';
export type { PlayerMessage, RevealOutput } from './reveal.ts';
export {
  buildEnded,
  buildHostSnapshot,
  buildLeaderboard,
  buildPlayerSnapshot,
  buildQuestionMessage,
  buildRoster,
  computeLiveStats,
} from './views.ts';
export { buildResultsCsv } from './csv.ts';
