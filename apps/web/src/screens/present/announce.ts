import type { PresenterView } from '../../state/presenterView.ts';

/**
 * One sentence for the screen-reader live region each time the screen changes. The charts
 * carry their own once-a-second summaries; this only says where the game has got to. It must
 * not change with the count of players: the lobby's PIN is said once, when the lobby appears,
 * and joins have a region of their own (`joinAnnouncement`).
 */
export function announcementFor(view: PresenterView): string {
  switch (view.screen) {
    case 'connecting':
      return 'Connecting';
    case 'lobby':
      return `Lobby. PIN ${view.pin.split('').join(' ')}.`;
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

/** The least time between two announcements of who has joined: a room fills in seconds. */
export const JOIN_ANNOUNCE_MS = 10_000;

/**
 * Who has joined, for a live region of its own. It carries no PIN, and nothing for an empty
 * room, which is not news. The count is not read out per join: see `JOIN_ANNOUNCE_MS`.
 */
export function joinAnnouncement(players: number): string {
  if (players <= 0) return '';
  return players === 1 ? '1 player has joined.' : `${players} players have joined.`;
}
