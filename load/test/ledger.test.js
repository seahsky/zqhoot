import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Ledger, buildSequence, snapshotKey } from '../lib/ledger.js';

// Three questions: 0 scored, 1 a poll (no leaderboard), 2 scored.
// Sequence: q0:question q0:reveal q0:leaderboard q1:question q1:reveal q2:question q2:reveal
//           q2:leaderboard ended
const scored = [true, false, true];
const sequence = () => buildSequence(scored);
const all = sequence().map((e) => e.key);

const deliver = (ledger, keys) => keys.forEach((key) => ledger.receive(key));

test('the sequence owes question and reveal per question, a leaderboard when scored, one ended', () => {
  assert.deepEqual(all, [
    'q0:question',
    'q0:reveal',
    'q0:leaderboard',
    'q1:question',
    'q1:reveal',
    'q2:question',
    'q2:reveal',
    'q2:leaderboard',
    'ended',
  ]);
});

test('a clean game receives everything it is owed', () => {
  const ledger = new Ledger(sequence());
  ledger.join(null);
  deliver(ledger, all);
  const s = ledger.settle();
  assert.equal(s.expected, 9);
  assert.equal(s.received, 9);
  assert.equal(s.lost, 0);
  assert.equal(s.missed, 0);
  assert.equal(s.byType.leaderboard.expected, 2);
  assert.equal(s.byType.ended.expected, 1);
});

test('a message that never arrives is a loss', () => {
  const ledger = new Ledger(sequence());
  ledger.join(null);
  deliver(
    ledger,
    all.filter((key) => key !== 'q1:reveal'),
  );
  const s = ledger.settle();
  assert.equal(s.expected, 9);
  assert.equal(s.received, 8);
  assert.equal(s.lost, 1);
  assert.equal(s.byType.reveal.lost, 1);
});

test('messages owed at the end of a game that stopped early are lost', () => {
  const ledger = new Ledger(sequence());
  ledger.join(null);
  deliver(ledger, all.slice(0, 4));
  const s = ledger.settle();
  assert.equal(s.received, 4);
  assert.equal(s.lost, 5);
});

test('a reveal inside a disconnect window is missed, and the snapshot counts for its phase', () => {
  const ledger = new Ledger(sequence());
  ledger.join(null);
  deliver(ledger, ['q0:question', 'q0:reveal', 'q0:leaderboard', 'q1:question']);
  ledger.disconnect();
  // While away: q1:reveal was broadcast and the host moved on to q2. The welcome reports q2.
  ledger.resume(snapshotKey('question', 2));
  deliver(ledger, ['q2:reveal', 'q2:leaderboard', 'ended']);
  const s = ledger.settle();
  assert.equal(s.missed, 1);
  assert.equal(s.lost, 0);
  assert.equal(s.expected, 8);
  assert.equal(s.received, 8);
  assert.equal(s.viaSnapshot, 1);
  assert.equal(s.byType.reveal.missed, 1);
});

test('resuming in the phase already seen adds nothing and misses nothing', () => {
  const ledger = new Ledger(sequence());
  ledger.join(null);
  deliver(ledger, ['q0:question']);
  ledger.disconnect();
  ledger.resume(snapshotKey('question', 0));
  deliver(ledger, all.slice(1));
  const s = ledger.settle();
  assert.equal(s.expected, 9);
  assert.equal(s.received, 9);
  assert.equal(s.missed, 0);
  assert.equal(s.viaSnapshot, 0);
});

test('a snapshot in revealing covers the question only, the reveal still arrives', () => {
  const ledger = new Ledger(sequence());
  ledger.join(null);
  deliver(ledger, ['q0:question', 'q0:reveal', 'q0:leaderboard']);
  ledger.disconnect();
  ledger.resume(snapshotKey('revealing', 1));
  deliver(ledger, ['q1:reveal', 'q2:question', 'q2:reveal', 'q2:leaderboard', 'ended']);
  const s = ledger.settle();
  assert.equal(s.missed, 0);
  assert.equal(s.lost, 0);
  assert.equal(s.received, 9);
  assert.equal(s.viaSnapshot, 1);
});

test('a reveal snapshot counts the reveal; the question before it is in the window', () => {
  const ledger = new Ledger(sequence());
  ledger.join(null);
  deliver(ledger, ['q0:question', 'q0:reveal', 'q0:leaderboard']);
  ledger.disconnect();
  ledger.resume(snapshotKey('reveal', 1));
  deliver(ledger, ['q2:question', 'q2:reveal', 'q2:leaderboard', 'ended']);
  const s = ledger.settle();
  assert.equal(s.missed, 1);
  assert.equal(s.byType.question.missed, 1);
  assert.equal(s.expected, 8);
  assert.equal(s.received, 8);
});

test('a gap before the disconnect is a loss, not a disconnect window', () => {
  const ledger = new Ledger(sequence());
  ledger.join(null);
  // q0:reveal never arrived although q0:leaderboard did: lost while connected.
  deliver(ledger, ['q0:question', 'q0:leaderboard']);
  ledger.disconnect();
  ledger.resume(snapshotKey('leaderboard', 2));
  deliver(ledger, ['ended']);
  const s = ledger.settle();
  assert.equal(s.lost, 1);
  assert.equal(s.byType.reveal.lost, 1);
  assert.equal(s.missed, 4);
  assert.equal(s.expected, 5);
  assert.equal(s.received, 4);
});

test('a resume that never succeeds leaves everything after it as lost', () => {
  const ledger = new Ledger(sequence());
  ledger.join(null);
  deliver(ledger, all.slice(0, 4));
  ledger.disconnect();
  const s = ledger.settle();
  assert.equal(s.missed, 0);
  assert.equal(s.lost, 5);
});

test('a second disconnect measures its window from what the first resume caught up to', () => {
  const ledger = new Ledger(sequence());
  ledger.join(null);
  deliver(ledger, ['q0:question']);
  ledger.disconnect();
  ledger.resume(snapshotKey('leaderboard', 0));
  deliver(ledger, ['q1:question']);
  ledger.disconnect();
  ledger.resume(snapshotKey('question', 2));
  deliver(ledger, ['q2:reveal', 'q2:leaderboard', 'ended']);
  const s = ledger.settle();
  // Window one: q0:reveal. Window two: q1:reveal.
  assert.equal(s.missed, 2);
  assert.equal(s.lost, 0);
  assert.equal(s.expected, 7);
  assert.equal(s.received, 7);
});

test('a late arrival after being classified as missed becomes a delivery', () => {
  const ledger = new Ledger(sequence());
  ledger.join(null);
  deliver(ledger, ['q0:question']);
  ledger.disconnect();
  ledger.resume(snapshotKey('leaderboard', 0));
  ledger.receive('q0:reveal');
  deliver(ledger, all.slice(3));
  const s = ledger.settle();
  assert.equal(s.missed, 0);
  assert.equal(s.expected, 9);
  assert.equal(s.received, 9);
});

test('duplicates are counted once as deliveries and reported separately', () => {
  const ledger = new Ledger(sequence());
  ledger.join(null);
  assert.equal(ledger.receive('q0:question'), 'first');
  assert.equal(ledger.receive('q0:question'), 'duplicate');
  assert.equal(ledger.receive('q9:question'), 'unknown');
  const s = ledger.settle();
  assert.equal(s.received, 1);
  assert.equal(s.duplicates, 1);
});

test('a player who joins mid-game is not owed what came before', () => {
  const ledger = new Ledger(sequence());
  ledger.join(snapshotKey('question', 1));
  deliver(ledger, ['q1:reveal', 'q2:question', 'q2:reveal', 'q2:leaderboard', 'ended']);
  const s = ledger.settle();
  assert.equal(s.skipped, 3);
  assert.equal(s.expected, 6);
  assert.equal(s.received, 6);
});

test('settle can be repeated', () => {
  const ledger = new Ledger(sequence());
  ledger.join(null);
  deliver(ledger, all.slice(0, 2));
  assert.deepEqual(ledger.settle(), ledger.settle());
});
