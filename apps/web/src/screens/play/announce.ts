import { revealHeadline, standingSentence } from '../../state/format.ts';
import type { PlayerView } from '../../state/player.ts';
import { isTextQuestion } from '../../state/player.ts';

/**
 * One sentence for the screen-reader live region each time the screen changes. Kept short
 * and free of per-second detail; the visible screen carries the rest.
 */
export function announcementFor(view: PlayerView): string {
  switch (view.screen) {
    case 'connecting':
      return 'Connecting';
    case 'lobby':
      return "You're in. Watch the big screen.";
    case 'get-ready':
      return `Question ${view.q.index + 1}. Options open in a moment.`;
    case 'answering':
      return 'Options are open.';
    case 'submitted':
      return isTextQuestion(view.q.question)
        ? `Thanks, your response is in. ${view.remaining} more allowed.`
        : 'Answer locked in';
    case 'times-up':
      return "Time's up";
    case 'reveal':
      return revealHeadline(view);
    case 'leaderboard':
      return standingSentence(view.standing);
    case 'ended':
      return 'Game over';
    case 'kicked':
      return 'The host removed you from this game';
    case 'session-over':
      return 'This game has ended';
    case 'out-of-date':
      return 'This page is out of date. Reload it to keep playing.';
  }
}
