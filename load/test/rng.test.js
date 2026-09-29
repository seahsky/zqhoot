import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isSelected, makeRng } from '../lib/rng.js';

test('the same seed and stream give the same sequence, another stream a different one', () => {
  const a = makeRng(1, 7);
  const b = makeRng(1, 7);
  const c = makeRng(1, 8);
  const first = [a.next(), a.next(), a.next()];
  assert.deepEqual([b.next(), b.next(), b.next()], first);
  assert.notDeepEqual([c.next(), c.next(), c.next()], first);
});

test('values stay in range', () => {
  const rng = makeRng(3, 3);
  for (let i = 0; i < 1000; i++) {
    const x = rng.next();
    assert.ok(x >= 0 && x < 1);
    const r = rng.range(2, 5);
    assert.ok(r >= 2 && r < 5);
    const n = rng.int(1, 3);
    assert.ok(n >= 1 && n <= 3 && Number.isInteger(n));
  }
});

test('the log-normal think time has the requested median', () => {
  const rng = makeRng(5, 1);
  const samples = Array.from({ length: 20001 }, () => rng.lognormal(3, 0.5)).sort((a, b) => a - b);
  const median = samples[10000];
  assert.ok(median > 2.85 && median < 3.15, `median ${median}`);
});

test('isSelected picks round(ratio * n) of n players, spread evenly, and never by chance', () => {
  const chosen = (n, ratio) =>
    Array.from({ length: n }, (_, i) => i).filter((i) => isSelected(i, ratio));
  assert.equal(chosen(400, 0.1).length, 40);
  assert.deepEqual(chosen(30, 0.1), [9, 19, 29]);
  assert.equal(chosen(400, 0).length, 0);
  assert.equal(chosen(400, 1).length, 400);
  assert.equal(chosen(400, 0.25).length, 100);
});
