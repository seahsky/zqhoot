/**
 * The list of gallery screens, as plain data. Playwright imports this file (it cannot
 * import the React registry: CSS modules), so it must stay free of React and CSS.
 *
 * Adding a screen is one line here plus one line in `registry.tsx`; the `ScreenId` type
 * makes the compiler reject a registry that misses or invents an id.
 *
 * Conventions: ids are `{group}-{name}`. Ids starting with `present-` are exempt from the
 * no-horizontal-scroll check (the stage is letterboxed, not scrolled).
 */
export type ScreenGroup = 'landing' | 'join' | 'play' | 'present' | 'host' | 'edit';

export interface ScreenMeta {
  id: string;
  title: string;
  group: ScreenGroup;
}

export const SCREENS = [
  { id: 'landing', title: 'Landing', group: 'landing' },

  { id: 'join-pin', title: 'Join: enter PIN', group: 'join' },
  { id: 'join-pin-error', title: 'Join: PIN error', group: 'join' },
  { id: 'join-nickname', title: 'Join: pick a nickname', group: 'join' },
  { id: 'join-nickname-error', title: 'Join: nickname error', group: 'join' },

  { id: 'play-lobby', title: 'Play: lobby', group: 'play' },
  { id: 'play-get-ready', title: 'Play: get ready', group: 'play' },
  { id: 'play-answer-single', title: 'Play: single choice', group: 'play' },
  {
    id: 'play-answer-single-long',
    title: 'Play: single choice, 80-character options',
    group: 'play',
  },
  { id: 'play-answer-truefalse', title: 'Play: true or false', group: 'play' },
  { id: 'play-answer-poll-6', title: 'Play: poll with six options', group: 'play' },
  { id: 'play-answer-wordcloud', title: 'Play: word cloud', group: 'play' },
  { id: 'play-answer-open', title: 'Play: open-ended', group: 'play' },
  { id: 'play-answer-rating', title: 'Play: rating', group: 'play' },
  { id: 'play-submitted', title: 'Play: answer locked in', group: 'play' },
  { id: 'play-times-up', title: "Play: time's up", group: 'play' },
  { id: 'play-reveal-correct', title: 'Play: reveal, correct', group: 'play' },
  { id: 'play-reveal-incorrect', title: 'Play: reveal, incorrect', group: 'play' },
  { id: 'play-reveal-unscored', title: 'Play: reveal, no points', group: 'play' },
  { id: 'play-reveal-no-answer', title: 'Play: reveal, no answer', group: 'play' },
  { id: 'play-leaderboard', title: 'Play: leaderboard standing', group: 'play' },
  { id: 'play-ended', title: 'Play: game over', group: 'play' },
  { id: 'play-reconnecting', title: 'Play: reconnecting', group: 'play' },
  { id: 'play-kicked', title: 'Play: removed by host', group: 'play' },
  { id: 'play-session-over', title: 'Play: game ended', group: 'play' },
  { id: 'play-out-of-date', title: 'Play: page out of date', group: 'play' },
] as const satisfies readonly ScreenMeta[];

export type ScreenId = (typeof SCREENS)[number]['id'];

/** The 16:9 presenter stage is letterboxed rather than scrolled, so it skips the scroll check. */
export function skipsHorizontalScrollCheck(id: string): boolean {
  return id.startsWith('present-');
}
