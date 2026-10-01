import type { PlayerStanding } from '@zqhoot/protocol';
import { SLOTS } from '../ui/slots.ts';
import type { OwnAnswer, PlayerView, RevealVariant } from './player.ts';

/** 1st, 2nd, 3rd, 4th ... 11th, 12th, 13th, 21st. */
export function ordinal(n: number): string {
  const mod100 = n % 100;
  if (mod100 >= 11 && mod100 <= 13) return `${n}th`;
  switch (n % 10) {
    case 1:
      return `${n}st`;
    case 2:
      return `${n}nd`;
    case 3:
      return `${n}rd`;
    default:
      return `${n}th`;
  }
}

/** Fixed locale so a phone set to another language still shows the same digits as the big screen. */
export function formatNumber(n: number): string {
  return n.toLocaleString('en-US');
}

export function pointsLabel(n: number): string {
  return `${formatNumber(n)} ${n === 1 ? 'point' : 'points'}`;
}

/** "You're 4th, 120 points behind Kim" */
export function standingSentence(standing: PlayerStanding): string {
  if (standing.rank === null) return `You have ${pointsLabel(standing.score)}`;
  const head = `You're ${ordinal(standing.rank)}`;
  if (!standing.behind) return head;
  return `${head}, ${pointsLabel(standing.behind.points)} behind ${standing.behind.nickname}`;
}

/** The result line on the reveal screen; text always accompanies the icon. */
export function revealHeadline(view: Extract<PlayerView, { screen: 'reveal' }>): string {
  const headlines: Record<RevealVariant, string> = {
    correct: `Correct, +${formatNumber(view.gained)}`,
    incorrect: 'Not this time',
    // Not the words of the "answer locked in" screen, which the player has just left.
    unscored: 'Question closed',
    'no-answer': "You didn't answer this one",
  };
  return headlines[view.variant];
}

/** What the player sent, as one line for the reveal: "Your answer: B · Pizza". */
export function ownAnswerLine(answer: OwnAnswer): string {
  switch (answer.kind) {
    case 'choice':
      return `Your answer: ${SLOTS[answer.slot]?.letter ?? answer.slot + 1} · ${answer.text}`;
    case 'rating':
      return `Your rating: ${answer.value} of ${answer.max}`;
    case 'words':
      return `Your ${answer.entries.length === 1 ? 'word' : 'words'}: ${answer.entries.join(', ')}`;
    case 'text':
      return `Your ${answer.entries.length === 1 ? 'response' : 'responses'}: ${answer.entries.join(' · ')}`;
  }
}

/**
 * Groups remaining seconds so the spoken countdown updates every 10 s, then at 10 and 5,
 * instead of every second. A change of tier is when to announce.
 */
export function timerTier(secondsLeft: number): number {
  if (secondsLeft > 10) return Math.ceil(secondsLeft / 10) * 10;
  return secondsLeft > 5 ? 10 : 5;
}

const segmenter =
  typeof Intl !== 'undefined' && 'Segmenter' in Intl
    ? new Intl.Segmenter(undefined, { granularity: 'grapheme' })
    : null;

/** User-perceived characters, which is how the server counts nickname length (ADR-0009). */
export function graphemeCount(text: string): number {
  if (!segmenter) return Array.from(text).length;
  let n = 0;
  for (const _ of segmenter.segment(text)) n += 1;
  return n;
}
