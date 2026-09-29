import type { PublicQuestion } from '@zqhoot/protocol';

const base = { timeLimitSec: 20 } as const;

export const singleShort: Extract<PublicQuestion, { type: 'single' }> = {
  ...base,
  id: 'question-planet',
  type: 'single',
  prompt: 'Which planet is closest to the Sun?',
  points: 1,
  options: [
    { id: 'option-mercury', text: 'Mercury' },
    { id: 'option-venus', text: 'Venus' },
    { id: 'option-earth', text: 'Earth' },
    { id: 'option-mars', text: 'Mars' },
  ],
};

/** Four options at exactly 80 characters, the protocol maximum (test/fixtures.test.ts checks). */
export const singleLong: Extract<PublicQuestion, { type: 'single' }> = {
  ...base,
  timeLimitSec: 30,
  id: 'question-long',
  type: 'single',
  prompt: 'Why did the lighthouse company change its opening hours last spring?',
  points: 1,
  options: [
    {
      id: 'option-long-a',
      text: 'The committee approved the plan only after a third round of very careful review.',
    },
    {
      id: 'option-long-b',
      text: "It shortens the time between a customer's request and the moment we can respond.",
    },
    {
      id: 'option-long-c',
      text: 'Nobody knows for certain, but the oldest records suggest it began beside rivers.',
    },
    {
      id: 'option-long-d',
      text: 'All of the above, although the first two matter far more than the last one does.',
    },
  ],
};

export const trueFalse: Extract<PublicQuestion, { type: 'truefalse' }> = {
  ...base,
  timeLimitSec: 10,
  id: 'question-wall',
  type: 'truefalse',
  prompt: 'The Great Wall of China can be seen from the Moon with the naked eye.',
  points: 1,
};

export const poll6: Extract<PublicQuestion, { type: 'poll' }> = {
  ...base,
  timeLimitSec: 30,
  id: 'question-snack',
  type: 'poll',
  prompt: 'Which snack should we order for the break?',
  options: [
    { id: 'option-popcorn', text: 'Popcorn' },
    { id: 'option-pretzels', text: 'Pretzels' },
    { id: 'option-fruit', text: 'Fresh fruit' },
    { id: 'option-cookies', text: 'Cookies' },
    { id: 'option-nuts', text: 'Mixed nuts' },
    { id: 'option-veg', text: 'Veggie sticks' },
  ],
};

export const wordCloud: Extract<PublicQuestion, { type: 'wordcloud' }> = {
  ...base,
  timeLimitSec: 45,
  id: 'question-weather',
  type: 'wordcloud',
  prompt: 'Describe this week in one word.',
  maxEntries: 3,
};

export const openEnded: Extract<PublicQuestion, { type: 'open' }> = {
  ...base,
  timeLimitSec: 90,
  id: 'question-offsite',
  type: 'open',
  prompt: 'What should we do at the next team offsite?',
  maxEntries: 2,
};

export const rating: Extract<PublicQuestion, { type: 'rating' }> = {
  ...base,
  timeLimitSec: null,
  id: 'question-rating',
  type: 'rating',
  prompt: 'How likely are you to recommend this workshop to a colleague?',
  max: 7,
  minLabel: 'Not at all likely',
  maxLabel: 'Extremely likely',
};

/** The same poll, for the "no points" reveal. */
export const pollShort: Extract<PublicQuestion, { type: 'poll' }> = {
  ...base,
  id: 'question-lunch',
  type: 'poll',
  prompt: 'Where should we eat lunch?',
  options: [
    { id: 'option-cafe', text: 'The cafe' },
    { id: 'option-park', text: 'Picnic in the park' },
  ],
};
