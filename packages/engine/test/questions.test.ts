import { describe, expect, it } from 'vitest';
import { PublicQuestion } from '@zqhoot/protocol';
import type { Question } from '@zqhoot/protocol';
import { isScoringQuestion, questionLimitMs, toPublicQuestion } from '../src/index.ts';
import { SETTINGS, questions } from './helpers.ts';

const HIDE = { ...SETTINGS, showQuestionOnDevices: false };
const FORBIDDEN_KEYS = ['correctOptionId', 'correct', 'requireApproval'];

describe('toPublicQuestion', () => {
  it.each(questions().map((q) => [q.type, q] as const))('projects a %s question', (_type, q) => {
    const pub = toPublicQuestion(q, SETTINGS);
    expect(PublicQuestion.safeParse(pub).success).toBe(true);
    expect(pub.type).toBe(q.type);
    expect(pub.id).toBe(q.id);
    expect(pub.prompt).toBe(q.prompt);
    expect(pub.timeLimitSec).toBe(q.timeLimitSec);
  });

  it('never exposes answer-derived fields, for every question type', () => {
    for (const q of questions()) {
      for (const settings of [SETTINGS, HIDE]) {
        const json = JSON.stringify(toPublicQuestion(q, settings));
        for (const key of FORBIDDEN_KEYS)
          expect(json, `${q.type}: ${key}`).not.toContain(`"${key}"`);
      }
    }
  });

  it('does not copy unknown fields, so a future answer field cannot leak', () => {
    const single = questions()[0];
    if (single?.type !== 'single') throw new Error('fixture');
    const q = {
      ...single,
      secret: 'nope',
      options: single.options.map((o) => ({ ...o, correct: true })),
    } as unknown as Question;
    const json = JSON.stringify(toPublicQuestion(q, SETTINGS));
    expect(json).not.toContain('secret');
    expect(json).not.toContain('correct');
  });

  it('omits the prompt when the quiz hides question text on devices', () => {
    for (const q of questions()) {
      const pub = toPublicQuestion(q, HIDE);
      expect('prompt' in pub).toBe(false);
      expect(JSON.stringify(pub)).not.toContain(q.prompt);
    }
  });

  it('keeps answer options when the prompt is hidden', () => {
    const single = questions()[0] as Question;
    const pub = toPublicQuestion(single, HIDE);
    expect(pub.type === 'single' && pub.options.map((o) => o.text)).toEqual([
      'Paris',
      'Rome',
      'Oslo',
    ]);
  });

  it('projects each type field by field', () => {
    const [single, truefalse, poll, wordcloud, open, rating] = questions() as [
      Question,
      Question,
      Question,
      Question,
      Question,
      Question,
    ];
    expect(toPublicQuestion(single, SETTINGS)).toStrictEqual({
      id: 'q-single',
      type: 'single',
      prompt: 'Capital of France?',
      timeLimitSec: 20,
      options: [
        { id: 'opt-paris', text: 'Paris' },
        { id: 'opt-rome', text: 'Rome' },
        { id: 'opt-oslo', text: 'Oslo' },
      ],
      points: 1,
    });
    expect(toPublicQuestion(truefalse, SETTINGS)).toStrictEqual({
      id: 'q-truefalse',
      type: 'truefalse',
      prompt: 'The sky is green',
      timeLimitSec: 10,
      points: 2,
    });
    expect(toPublicQuestion(poll, SETTINGS)).toStrictEqual({
      id: 'q-poll',
      type: 'poll',
      prompt: 'Favourite colour?',
      timeLimitSec: null,
      options: [
        { id: 'opt-red', text: 'Red' },
        { id: 'opt-blue', text: 'Blue' },
      ],
    });
    expect(toPublicQuestion(wordcloud, SETTINGS)).toStrictEqual({
      id: 'q-wordcloud',
      type: 'wordcloud',
      prompt: 'One word',
      timeLimitSec: 30,
      maxEntries: 3,
    });
    expect(toPublicQuestion(open, SETTINGS)).toStrictEqual({
      id: 'q-open',
      type: 'open',
      prompt: 'Tell us more',
      timeLimitSec: 60,
      maxEntries: 2,
    });
    expect(toPublicQuestion(rating, SETTINGS)).toStrictEqual({
      id: 'q-rating',
      type: 'rating',
      prompt: 'Rate it',
      timeLimitSec: 15,
      max: 5,
      minLabel: 'Bad',
      maxLabel: 'Great',
    });
  });

  it('carries the image key and omits absent optional fields', () => {
    const withImage: Question = {
      id: 'q-image',
      type: 'wordcloud',
      prompt: 'Look',
      timeLimitSec: 20,
      maxEntries: 1,
      imageKey: 'media/abcdef/abcdef.png',
    };
    expect(toPublicQuestion(withImage, SETTINGS)).toMatchObject({
      imageKey: 'media/abcdef/abcdef.png',
    });
    const rating: Question = {
      id: 'q-rate',
      type: 'rating',
      prompt: 'x',
      timeLimitSec: null,
      max: 3,
    };
    const pub = toPublicQuestion(rating, SETTINGS);
    expect(Object.keys(pub).sort()).toEqual(['id', 'max', 'prompt', 'timeLimitSec', 'type']);
  });

  it('keeps the image description for hosts: players get the key and nothing that describes it', () => {
    // The presenter reads the full question from the host snapshot. A phone never draws the
    // picture, and a description of it can give the answer away ("a photo of Saturn"), so the
    // player projection stays field by field and leaves the alt text behind.
    const withAlt: Question = {
      id: 'q-alt',
      type: 'single',
      prompt: 'Which planet is this?',
      timeLimitSec: 20,
      imageKey: 'media/abcdef/abcdef.png',
      imageAlt: 'Saturn, with its rings edge-on',
      options: [
        { id: 'a', text: 'Saturn' },
        { id: 'b', text: 'Mars' },
      ],
      correctOptionId: 'a',
      points: 1,
    };
    const pub = toPublicQuestion(withAlt, SETTINGS);
    expect(pub).toMatchObject({ imageKey: 'media/abcdef/abcdef.png' });
    expect(pub).not.toHaveProperty('imageAlt');
    expect(JSON.stringify(pub)).not.toContain('Saturn, with');
  });

  it('does not alias the source options', () => {
    const q = questions()[0] as Question;
    const pub = toPublicQuestion(q, SETTINGS);
    if (pub.type !== 'single' || q.type !== 'single') throw new Error('fixture');
    pub.options[0]!.text = 'changed';
    expect(q.options[0]!.text).toBe('Paris');
  });
});

describe('questionLimitMs', () => {
  it('converts seconds to ms and keeps untimed as null', () => {
    const [single, , poll] = questions() as [Question, Question, Question];
    expect(questionLimitMs(single)).toBe(20_000);
    expect(questionLimitMs(poll)).toBeNull();
  });
});

describe('isScoringQuestion', () => {
  it('is true only for scored types with a positive multiplier', () => {
    const byId = Object.fromEntries(questions().map((q) => [q.id, isScoringQuestion(q)]));
    expect(byId).toEqual({
      'q-single': true,
      'q-truefalse': true,
      'q-poll': false,
      'q-wordcloud': false,
      'q-open': false,
      'q-rating': false,
      'q-zero': false,
      'q-last': true,
    });
  });
});
