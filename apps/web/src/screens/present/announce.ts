import type { PresenterView } from '../../state/presenterView.ts';

/**
 * One sentence for the screen-reader live region each time the screen changes. The charts
 * carry their own once-a-second summaries; this only says where the game has got to.
 */
export function announcementFor(view: PresenterView): string {
  switch (view.screen) {
    case 'connecting':
      return 'Connecting';
    case 'lobby':
      return `Lobby. PIN ${view.pin.split('').join(' ')}. ${view.names.length} players have joined.`;
    case 'get-ready':
      return `Question ${view.q.index + 1} of ${view.q.total}. Options open in a moment.`;
    case 'question':
      return 'Options are open.';
    case 'closing':
      return "Time's up.";
    case 'reveal':
      return `Results for question ${view.q.index + 1}.`;
    case 'leaderboard':
      return `Leaderboard after question ${view.index + 1}.`;
    case 'podium':
      return 'Final results.';
    case 'thanks':
      return 'Thanks for taking part.';
    case 'over':
      return 'This game is not available.';
  }
}
