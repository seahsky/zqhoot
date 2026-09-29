import { DEFAULT_QUIZ_SETTINGS } from '@zqhoot/protocol';
import type { Question } from '@zqhoot/protocol';
import { validateDraft } from '../../state/editor.ts';
import type { FieldIssue, QuizDraft } from '../../state/editor.ts';
import {
  IMAGE_KEY,
  openQ,
  pollQ,
  ratingQ,
  singleImageQ,
  singleQ,
  trueFalseQ,
  wordCloudQ,
} from './hostSnapshots.ts';

/**
 * Editor fixtures: a quiz with one question of every type, and the states the screen must show
 * (a question open at each type, validation errors, a save conflict).
 */
export const EDIT_QUIZ: QuizDraft = {
  title: 'Friday night trivia',
  settings: { ...DEFAULT_QUIZ_SETTINGS, streakBonus: true },
  questions: [
    { ...singleQ },
    { ...trueFalseQ },
    { ...pollQ },
    { ...wordCloudQ },
    { ...openQ },
    { ...ratingQ },
  ],
};

/** Index of the question of each type in `EDIT_QUIZ`. */
export const EDIT_INDEX = {
  single: 0,
  truefalse: 1,
  poll: 2,
  wordcloud: 3,
  open: 4,
  rating: 5,
} as const;

/** The single-choice question with a picture, for the image preview. */
export const EDIT_WITH_IMAGE: QuizDraft = {
  ...EDIT_QUIZ,
  questions: [
    { ...singleImageQ, imageKey: IMAGE_KEY } as Question,
    ...EDIT_QUIZ.questions.slice(1),
  ],
};

/** A draft with mistakes in several places, and the issues the real validator reports for it. */
export const EDIT_BROKEN: QuizDraft = {
  title: '',
  settings: { ...DEFAULT_QUIZ_SETTINGS },
  questions: [
    {
      ...singleQ,
      prompt: '',
      options: singleQ.options.map((o, i) => (i === 1 ? { ...o, text: '' } : o)),
    },
    {
      ...pollQ,
      prompt: 'Where should we eat lunch?',
      options: pollQ.options.map((o, i) => (i === 2 ? { ...o, text: '' } : o)),
    },
    { ...ratingQ, prompt: '' },
  ],
};

export function issuesOf(draft: QuizDraft): FieldIssue[] {
  const r = validateDraft(draft);
  return r.ok ? [] : r.issues;
}

/** The fixed URL a picture resolves to in the gallery. */
export { DEMO_IMAGE_URL } from './images.ts';
