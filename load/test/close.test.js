import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { TIMING } from '../../packages/protocol/src/index.ts';
import { ANSWER_GRACE_MS, everyoneAnswered, timerCloseDelayMs } from '../lib/close.js';

test("the grace is the protocol's answer grace", () => {
  assert.equal(ANSWER_GRACE_MS, TIMING.answerGraceMs);
});

test('the timer close is due at deadline + grace on the server timeline', () => {
  const deadline = 1_000_000;
  // The local clock reads the server's plus 40 ms.
  const offset = 40;
  assert.equal(timerCloseDelayMs(deadline, offset, deadline + offset), ANSWER_GRACE_MS);
  assert.equal(timerCloseDelayMs(deadline, offset, deadline + offset + ANSWER_GRACE_MS), 0);
  assert.equal(
    timerCloseDelayMs(deadline, offset, deadline + offset - 5_000),
    5_000 + ANSWER_GRACE_MS,
  );
});

test('everyone has answered against `expected`, so a player who dropped out does not hold it open', () => {
  assert.equal(everyoneAnswered({ answered: 9, totalPlayers: 12, expected: 9 }), true);
  assert.equal(everyoneAnswered({ answered: 10, totalPlayers: 12, expected: 9 }), true);
  assert.equal(everyoneAnswered({ answered: 8, totalPlayers: 12, expected: 9 }), false);
});

test('a player who is connected and has not answered keeps the question open', () => {
  assert.equal(everyoneAnswered({ answered: 11, totalPlayers: 12, expected: 12 }), false);
  assert.equal(everyoneAnswered({ answered: 12, totalPlayers: 12, expected: 12 }), true);
});

test('without `expected` the host falls back to totalPlayers', () => {
  assert.equal(everyoneAnswered({ answered: 11, totalPlayers: 12 }), false);
  assert.equal(everyoneAnswered({ answered: 12, totalPlayers: 12 }), true);
});

test('an empty room is never everyone', () => {
  assert.equal(everyoneAnswered({ answered: 0, totalPlayers: 0 }), false);
  assert.equal(everyoneAnswered({ answered: 0, totalPlayers: 5, expected: 0 }), false);
});

test('the k6 host takes both decisions from these helpers', () => {
  const source = readFileSync(new URL('../lib/host.js', import.meta.url), 'utf8');
  assert.match(source, /from '\.\/close\.js'/);
  assert.match(source, /timerCloseDelayMs\(deadline, this\.clock\.get\(\), Date\.now\(\)\)/);
  assert.match(source, /everyoneAnswered\(message\.stats\)/);
  // The bare deadline is what F1 moved the web driver away from.
  assert.doesNotMatch(source, /deadline \+ this\.clock\.get\(\) - Date\.now\(\)/);
});
