import assert from 'node:assert/strict';
import { test } from 'node:test';
import { QuizInput } from '../../packages/protocol/src/index.ts';
import { buildQuiz, questionType, scoredFlags } from '../lib/quiz.js';

const build = (questions) => buildQuiz({ questions, timeLimit: 20, readSeconds: 0 });

test('the generated quiz is accepted by the protocol schema', () => {
  for (const questions of [1, 3, 10, 25]) {
    const parsed = QuizInput.safeParse(build(questions));
    assert.ok(parsed.success, JSON.stringify(parsed.error?.issues));
    assert.equal(parsed.data.questions.length, questions);
  }
});

test('ten questions are seven single choice, two true/false and one poll, all timed', () => {
  const quiz = build(10);
  const count = (type) => quiz.questions.filter((q) => q.type === type).length;
  assert.equal(count('single'), 7);
  assert.equal(count('truefalse'), 2);
  assert.equal(count('poll'), 1);
  assert.ok(quiz.questions.every((q) => q.timeLimitSec === 20));
  assert.equal(questionType(5), 'poll');
});

test('only scored questions are followed by a leaderboard', () => {
  const quiz = build(10);
  const flags = scoredFlags(quiz);
  assert.equal(flags.length, 10);
  assert.equal(flags[5], false);
  assert.equal(flags.filter(Boolean).length, 9);
});
