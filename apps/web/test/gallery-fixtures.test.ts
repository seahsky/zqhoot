import { describe, expect, it } from 'vitest';
import { LIMITS, PublicQuestion, ServerMessage } from '@zqhoot/protocol';
import { SCREENS, skipsHorizontalScrollCheck } from '../src/dev/manifest.ts';
import * as Q from '../src/dev/fixtures/questions.ts';
import { FIXTURE_MESSAGES, PLAY_FIXTURES } from '../src/dev/fixtures/player.ts';
import { announcementFor } from '../src/screens/play/announce.ts';

/** The screens this task must deliver (docs/tasks/W1-web-a.md). */
const REQUIRED = [
  'landing',
  'join-pin',
  'join-pin-error',
  'join-nickname',
  'join-nickname-error',
  'play-lobby',
  'play-get-ready',
  'play-answer-single',
  'play-answer-single-long',
  'play-answer-truefalse',
  'play-answer-poll-6',
  'play-answer-wordcloud',
  'play-answer-open',
  'play-answer-rating',
  'play-submitted',
  'play-times-up',
  'play-reveal-correct',
  'play-reveal-incorrect',
  'play-reveal-unscored',
  'play-reveal-no-answer',
  'play-leaderboard',
  'play-ended',
  'play-reconnecting',
  'play-kicked',
  'play-session-over',
];

describe('gallery manifest', () => {
  const ids: string[] = SCREENS.map((s) => s.id);

  it('has every required screen, once', () => {
    for (const id of REQUIRED) expect(ids, id).toContain(id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('names ids after their group, in kebab case', () => {
    for (const s of SCREENS) {
      expect(s.id).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
      if (s.group !== 'landing') expect(s.id.startsWith(`${s.group}-`), s.id).toBe(true);
    }
  });

  it('exempts only presenter screens from the horizontal-scroll check', () => {
    expect(skipsHorizontalScrollCheck('present-question')).toBe(true);
    expect(skipsHorizontalScrollCheck('play-lobby')).toBe(false);
    expect(skipsHorizontalScrollCheck('host-lobby')).toBe(false);
  });

  it('has a fixture for every play screen and none that are unlisted', () => {
    const play = ids.filter((id) => id.startsWith('play-')).sort();
    expect(Object.keys(PLAY_FIXTURES).sort()).toEqual(play);
  });
});

describe('play fixtures', () => {
  it('every message they send is valid protocol', () => {
    expect(FIXTURE_MESSAGES.length).toBeGreaterThan(20);
    for (const msg of FIXTURE_MESSAGES) {
      const parsed = ServerMessage.safeParse(msg);
      expect(parsed.success, JSON.stringify(msg).slice(0, 120)).toBe(true);
    }
  });

  it('every question is a valid PublicQuestion', () => {
    for (const [name, q] of Object.entries(Q)) {
      expect(PublicQuestion.safeParse(q).success, name).toBe(true);
    }
  });

  it('the long-option question really has four 80-character options', () => {
    expect(Q.singleLong.options).toHaveLength(4);
    for (const o of Q.singleLong.options) expect(o.text).toHaveLength(LIMITS.optionTextMax);
  });

  it('the six-option poll has six options and the rating a range', () => {
    expect(Q.poll6.options).toHaveLength(LIMITS.pollOptionsMax);
    expect(Q.rating.max).toBeGreaterThanOrEqual(LIMITS.ratingMaxMin);
  });

  it('each fixture lands on the screen its name promises', () => {
    const expected: Record<keyof typeof PLAY_FIXTURES, string> = {
      'play-lobby': 'lobby',
      'play-get-ready': 'get-ready',
      'play-answer-single': 'answering',
      'play-answer-single-long': 'answering',
      'play-answer-truefalse': 'answering',
      'play-answer-poll-6': 'answering',
      'play-answer-wordcloud': 'answering',
      'play-answer-open': 'answering',
      'play-answer-rating': 'answering',
      'play-submitted': 'submitted',
      'play-times-up': 'times-up',
      'play-reveal-correct': 'reveal',
      'play-reveal-incorrect': 'reveal',
      'play-reveal-unscored': 'reveal',
      'play-reveal-no-answer': 'reveal',
      'play-leaderboard': 'leaderboard',
      'play-ended': 'ended',
      'play-reconnecting': 'answering',
      'play-kicked': 'kicked',
      'play-session-over': 'session-over',
      'play-out-of-date': 'out-of-date',
    };
    for (const [id, screen] of Object.entries(expected)) {
      expect(PLAY_FIXTURES[id as keyof typeof PLAY_FIXTURES].view.screen, id).toBe(screen);
    }
  });

  it('the reveal fixtures cover the four variants', () => {
    const variant = (id: keyof typeof PLAY_FIXTURES) => {
      const v = PLAY_FIXTURES[id].view;
      return v.screen === 'reveal' ? v.variant : null;
    };
    expect(variant('play-reveal-correct')).toBe('correct');
    expect(variant('play-reveal-incorrect')).toBe('incorrect');
    expect(variant('play-reveal-unscored')).toBe('unscored');
    expect(variant('play-reveal-no-answer')).toBe('no-answer');
  });

  it('the reconnecting fixture keeps its screen and flags the connection', () => {
    const s = PLAY_FIXTURES['play-reconnecting'];
    expect(s.connection).toBe('reconnecting');
    expect(s.view.screen).toBe('answering');
  });

  it('every screen has a non-empty screen-reader announcement', () => {
    for (const [id, state] of Object.entries(PLAY_FIXTURES)) {
      expect(announcementFor(state.view).length, id).toBeGreaterThan(3);
    }
  });
});
