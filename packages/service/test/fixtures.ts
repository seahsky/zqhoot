import type { Question, QuizInput } from '@zqhoot/protocol';

const opt = (id: string, text: string) => ({ id, text });

/** Indexes of `allTypesQuiz`, so tests read as prose. */
export const Q = { single: 0, truefalse: 1, poll: 2, wordcloud: 3, open: 4, rating: 5 } as const;

/** One question of every type. Time limits are chosen so the arithmetic in the tests stays round. */
export function allTypesQuestions(): Question[] {
  return [
    {
      id: 'q-single',
      type: 'single',
      prompt: 'Capital of France?',
      timeLimitSec: 20,
      options: [opt('opt-paris', 'Paris'), opt('opt-rome', 'Rome'), opt('opt-oslo', 'Oslo')],
      correctOptionId: 'opt-paris',
      points: 1,
    },
    {
      id: 'q-truefalse',
      type: 'truefalse',
      prompt: 'The sky is green',
      timeLimitSec: 10,
      correct: false,
      points: 2,
    },
    {
      id: 'q-poll',
      type: 'poll',
      prompt: 'Favourite colour?',
      timeLimitSec: null,
      options: [opt('opt-red', 'Red'), opt('opt-blue', 'Blue')],
    },
    { id: 'q-wordcloud', type: 'wordcloud', prompt: 'One word', timeLimitSec: 30, maxEntries: 3 },
    {
      id: 'q-open',
      type: 'open',
      prompt: 'Tell us more',
      timeLimitSec: 60,
      maxEntries: 2,
      requireApproval: true,
    },
    {
      id: 'q-rating',
      type: 'rating',
      prompt: 'Rate it',
      timeLimitSec: 15,
      max: 5,
      minLabel: 'Bad',
      maxLabel: 'Great',
    },
  ];
}

export function allTypesQuiz(settings: Partial<QuizInput['settings']> = {}): QuizInput {
  return {
    title: 'All question types',
    questions: allTypesQuestions(),
    settings: { streakBonus: true, showQuestionOnDevices: true, readSeconds: 3, ...settings },
  };
}

/** A short quiz for tests that only need a running game: scored, untimed poll, word cloud. */
export function miniQuiz(): QuizInput {
  const [single, , poll] = allTypesQuestions() as [Question, Question, Question];
  return {
    title: 'Mini quiz',
    questions: [
      single,
      poll,
      { id: 'q-words', type: 'wordcloud', prompt: 'One word', timeLimitSec: 30, maxEntries: 2 },
    ],
    settings: { streakBonus: false, showQuestionOnDevices: true, readSeconds: 3 },
  };
}

/** One word cloud question, for tests about entry limits and concurrent entries. */
export function wordCloudQuiz(maxEntries: number): QuizInput {
  return {
    title: 'Word cloud',
    questions: [
      { id: 'q-words', type: 'wordcloud', prompt: 'One word', timeLimitSec: 30, maxEntries },
    ],
    settings: { streakBonus: false, showQuestionOnDevices: true, readSeconds: 3 },
  };
}

/** One open-ended question that needs approval. */
export function openQuiz(): QuizInput {
  return {
    title: 'Open question',
    questions: [
      {
        id: 'q-open',
        type: 'open',
        prompt: 'Tell us more',
        timeLimitSec: 60,
        maxEntries: 2,
        requireApproval: true,
      },
    ],
    settings: { streakBonus: false, showQuestionOnDevices: true, readSeconds: 3 },
  };
}
