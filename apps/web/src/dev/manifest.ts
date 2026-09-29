/**
 * The list of gallery screens, as plain data. Playwright imports this file (it cannot
 * import the React registry: CSS modules), so it must stay free of React and CSS.
 *
 * Adding a screen is one line here plus one line in `registry.tsx`; the `ScreenId` type
 * makes the compiler reject a registry that misses or invents an id.
 *
 * Conventions: ids are `{group}-{name}`. Ids starting with `present-` are exempt from the
 * no-horizontal-scroll check (the stage is letterboxed, not scrolled). Screens of group `test`
 * exist to prove the e2e checks can fail; they are not screens of the app and stay out of the
 * axe and screenshot matrix (`MATRIX_SCREENS`).
 */
export type ScreenGroup = 'landing' | 'join' | 'play' | 'present' | 'host' | 'edit' | 'test';

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
  { id: 'play-ended', title: 'Play: final results', group: 'play' },
  { id: 'play-reconnecting', title: 'Play: reconnecting', group: 'play' },
  { id: 'play-kicked', title: 'Play: removed by host', group: 'play' },
  { id: 'play-session-over', title: 'Play: game ended', group: 'play' },
  { id: 'play-out-of-date', title: 'Play: page out of date', group: 'play' },

  { id: 'present-lobby', title: 'Present: lobby', group: 'present' },
  { id: 'present-lobby-400', title: 'Present: lobby with 400 players', group: 'present' },
  { id: 'present-get-ready', title: 'Present: get ready', group: 'present' },
  { id: 'present-question-open', title: 'Present: question open', group: 'present' },
  { id: 'present-question-image', title: 'Present: question with an image', group: 'present' },
  {
    id: 'present-question-long',
    title: 'Present: 200-character prompt, four 80-character options',
    group: 'present',
  },
  { id: 'present-reveal-single', title: 'Present: reveal, single choice', group: 'present' },
  { id: 'present-reveal-truefalse', title: 'Present: reveal, true or false', group: 'present' },
  { id: 'present-reveal-poll', title: 'Present: reveal, poll', group: 'present' },
  { id: 'present-wordcloud', title: 'Present: word cloud', group: 'present' },
  { id: 'present-open', title: 'Present: open-ended responses', group: 'present' },
  { id: 'present-rating', title: 'Present: rating', group: 'present' },
  { id: 'present-leaderboard', title: 'Present: leaderboard', group: 'present' },
  { id: 'present-podium', title: 'Present: podium', group: 'present' },
  {
    id: 'present-ended-unscored',
    title: 'Present: final screen, no scored questions',
    group: 'present',
  },
  { id: 'present-help', title: 'Present: keyboard help', group: 'present' },

  { id: 'host-login', title: 'Host: sign in', group: 'host' },
  { id: 'host-dashboard', title: 'Host: dashboard', group: 'host' },
  { id: 'host-live-lobby', title: 'Host: live control, lobby', group: 'host' },
  { id: 'host-live-question', title: 'Host: live control, question open', group: 'host' },
  { id: 'host-live-moderation', title: 'Host: live control, moderation queue', group: 'host' },
  { id: 'host-live-reveal', title: 'Host: live control, results', group: 'host' },

  { id: 'edit-quiz', title: 'Edit: quiz and question list', group: 'edit' },
  { id: 'edit-question-single', title: 'Edit: multiple choice question', group: 'edit' },
  { id: 'edit-question-truefalse', title: 'Edit: true or false question', group: 'edit' },
  { id: 'edit-question-poll', title: 'Edit: poll question', group: 'edit' },
  { id: 'edit-question-wordcloud', title: 'Edit: word cloud question', group: 'edit' },
  { id: 'edit-question-open', title: 'Edit: open-ended question', group: 'edit' },
  { id: 'edit-question-rating', title: 'Edit: rating question', group: 'edit' },
  { id: 'edit-errors', title: 'Edit: validation errors', group: 'edit' },
  { id: 'edit-conflict', title: 'Edit: save conflict', group: 'edit' },

  { id: 'test-overflow', title: 'Test: a deliberately over-wide element', group: 'test' },
] as const satisfies readonly ScreenMeta[];

export type ScreenId = (typeof SCREENS)[number]['id'];

/** The screens of the app: what the axe, screenshot and preference passes visit. */
export const MATRIX_SCREENS: readonly ScreenMeta[] = SCREENS.filter((s) => s.group !== 'test');

/** The 16:9 presenter stage is letterboxed rather than scrolled, so it skips the scroll check. */
export function skipsHorizontalScrollCheck(id: string): boolean {
  return id.startsWith('present-');
}
