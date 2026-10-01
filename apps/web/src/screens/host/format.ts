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

/** A `host.hello` refused with `forbidden`: the live control and the presenter say the same. */
export const FORBIDDEN_COPY = {
  title: 'This session belongs to another host',
  // Short: on the presenter's stage it has to fit at 150% text size beside two buttons.
  body: 'It was started from a different account. Sign out to switch, or go back to your own quizzes.',
};
