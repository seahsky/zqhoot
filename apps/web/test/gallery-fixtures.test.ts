import { describe, expect, it } from 'vitest';
import { LIMITS, PublicQuestion, ServerMessage } from '@zqhoot/protocol';
import { SCREENS, skipsHorizontalScrollCheck } from '../src/dev/manifest.ts';
import * as Q from '../src/dev/fixtures/questions.ts';
import { FIXTURE_MESSAGES, PLAY_FIXTURES } from '../src/dev/fixtures/player.ts';
import { announcementFor } from '../src/screens/play/announce.ts';
import { announcementFor as presentAnnouncement } from '../src/screens/present/announce.ts';
import { EDIT_BROKEN, EDIT_QUIZ, issuesOf } from '../src/dev/fixtures/edit.ts';
import { HOST_LIVE_FIXTURES } from '../src/dev/fixtures/host.ts';
import { HOST_FIXTURE_MESSAGES } from '../src/dev/fixtures/hostState.ts';
import { OPEN_QUESTION_COUNTS, PRESENT_FIXTURES } from '../src/dev/fixtures/present.ts';
import { names, roster } from '../src/dev/fixtures/hostSnapshots.ts';
import { NOW } from '../src/dev/fixtures/common.ts';
import { presenterView } from '../src/state/presenterView.ts';
import { validateDraft } from '../src/state/editor.ts';
import { HostSnapshot, Quiz, QuizInput } from '@zqhoot/protocol';

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
  'present-lobby',
  'present-lobby-400',
  'present-get-ready',
  'present-question-open',
  'present-question-image',
  'present-question-long',
  'present-reveal-single',
  'present-reveal-truefalse',
  'present-reveal-poll',
  'present-wordcloud',
  'present-open',
  'present-rating',
  'present-leaderboard',
  'present-podium',
  'present-ended-unscored',
  'present-help',
  'host-login',
  'host-dashboard',
  'host-live-lobby',
  'host-live-question',
  'host-live-moderation',
  'host-live-reveal',
  'edit-quiz',
  'edit-question-single',
  'edit-question-truefalse',
  'edit-question-poll',
  'edit-question-wordcloud',
  'edit-question-open',
  'edit-question-rating',
  'edit-errors',
  'edit-conflict',
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

describe('presenter fixtures', () => {
  it('have a fixture for every present screen and none that are unlisted', () => {
    const present = SCREENS.map((s) => s.id as string).filter((id) => id.startsWith('present-'));
    expect(Object.keys(PRESENT_FIXTURES).sort()).toEqual(present.sort());
  });

  it('every message the host fixtures send is valid protocol', () => {
    expect(HOST_FIXTURE_MESSAGES.length).toBeGreaterThan(20);
    for (const msg of HOST_FIXTURE_MESSAGES) {
      expect(ServerMessage.safeParse(msg).success, JSON.stringify(msg).slice(0, 120)).toBe(true);
    }
  });

  it('every host snapshot they hold parses, so the wire shape is what a server would send', () => {
    for (const [id, fx] of Object.entries(PRESENT_FIXTURES)) {
      expect(HostSnapshot.safeParse(fx.state.snapshot).success, id).toBe(true);
    }
    for (const [id, state] of Object.entries(HOST_LIVE_FIXTURES)) {
      expect(HostSnapshot.safeParse(state.snapshot).success, id).toBe(true);
    }
  });

  it('each lands on the screen its name promises', () => {
    const expected: Record<string, string> = {
      'present-lobby': 'lobby',
      'present-lobby-400': 'lobby',
      'present-get-ready': 'get-ready',
      'present-question-open': 'question',
      'present-question-image': 'question',
      'present-question-long': 'question',
      'present-reveal-single': 'reveal',
      'present-reveal-truefalse': 'reveal',
      'present-reveal-poll': 'reveal',
      'present-wordcloud': 'reveal',
      'present-open': 'reveal',
      'present-rating': 'reveal',
      'present-leaderboard': 'leaderboard',
      'present-podium': 'podium',
      'present-ended-unscored': 'thanks',
      'present-help': 'lobby',
    };
    for (const [id, screen] of Object.entries(expected)) {
      const fx = PRESENT_FIXTURES[id as keyof typeof PRESENT_FIXTURES];
      expect(presenterView(fx.state, NOW).screen, id).toBe(screen);
    }
  });

  it('the open question carries the answer and a distribution, and the room screen shows neither', () => {
    const fx = PRESENT_FIXTURES['present-question-open'];
    // The fixture really does contain what must stay hidden.
    const hosted = fx.state.snapshot?.question?.question;
    expect(hosted?.type === 'single' && hosted.correctOptionId).toBe('option-mercury');
    expect(fx.state.live?.stats).toMatchObject({ counts: OPEN_QUESTION_COUNTS });

    const text = JSON.stringify(presenterView(fx.state, NOW));
    expect(text).not.toContain('option-mercury');
    for (const n of Object.values(OPEN_QUESTION_COUNTS)) {
      expect(text).not.toMatch(new RegExp(`\\b${n}\\b`));
    }
  });

  it('the 400-player lobby has 400 distinct nicknames within the length limit', () => {
    const list = names(400);
    expect(new Set(list).size).toBe(400);
    for (const name of list) {
      expect(name.length).toBeGreaterThanOrEqual(2);
      expect(name.length).toBeLessThanOrEqual(LIMITS.nicknameMaxGraphemes);
    }
    expect(roster(400)).toHaveLength(400);
    const view = presenterView(PRESENT_FIXTURES['present-lobby-400'].state, NOW);
    expect(view.screen === 'lobby' && view.names.length).toBe(400);
  });

  it('every screen has a non-empty screen-reader announcement', () => {
    for (const [id, fx] of Object.entries(PRESENT_FIXTURES)) {
      expect(presentAnnouncement(presenterView(fx.state, NOW)).length, id).toBeGreaterThan(3);
    }
  });

  it('the long-question fixture has the protocol maxima: 200-character prompt, four 80-character options', () => {
    const q = PRESENT_FIXTURES['present-question-long'].state.snapshot?.question?.question;
    if (q?.type !== 'single') throw new Error('expected a single-choice question');
    expect(q.prompt).toHaveLength(LIMITS.questionPromptMax);
    expect(q.options).toHaveLength(4);
    for (const o of q.options) expect(o.text).toHaveLength(LIMITS.optionTextMax);
  });
});

describe('editor fixtures', () => {
  it('the sample quiz is a valid QuizInput with one question of every type', () => {
    expect(QuizInput.safeParse(EDIT_QUIZ).success).toBe(true);
    expect(EDIT_QUIZ.questions.map((q) => q.type)).toEqual([
      'single',
      'truefalse',
      'poll',
      'wordcloud',
      'open',
      'rating',
    ]);
    expect(validateDraft(EDIT_QUIZ).ok).toBe(true);
  });

  it('the broken quiz produces the issues the errors screen shows', () => {
    const issues = issuesOf(EDIT_BROKEN);
    expect(issues.length).toBeGreaterThanOrEqual(4);
    expect(issues.some((i) => i.fieldId === 'f-title')).toBe(true);
    expect(Quiz.safeParse(EDIT_BROKEN).success).toBe(false);
  });
});
