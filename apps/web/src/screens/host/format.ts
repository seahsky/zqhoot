import type { Phase } from '@zqhoot/protocol';

/** Fixed locale: the same words and order on every host's machine and in every screenshot. */
const WHEN = new Intl.DateTimeFormat('en-GB', {
  day: 'numeric',
  month: 'short',
  hour: '2-digit',
  minute: '2-digit',
});

export function formatWhen(epochMs: number): string {
  return WHEN.format(new Date(epochMs));
}

export const PHASE_LABEL: Record<Phase, string> = {
  lobby: 'Waiting to start',
  question: 'Question open',
  revealing: 'Working out results',
  reveal: 'Results shown',
  leaderboard: 'Leaderboard shown',
  ended: 'Ended',
};

export function playerCountLabel(n: number): string {
  return `${n} ${n === 1 ? 'player' : 'players'}`;
}

export function questionCountLabel(n: number): string {
  return `${n} ${n === 1 ? 'question' : 'questions'}`;
}
