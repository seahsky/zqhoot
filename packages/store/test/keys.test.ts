import { describe, expect, it } from 'vitest';
import { RESPONSE_SHARDS, responseShard } from '../src/index.ts';
import {
  fnv1a32,
  parseResponseId,
  responseKey,
  responsePlayerPrefix,
  responseSk,
  resultKey,
  sessionGsiSk,
} from '../src/keys.ts';

describe('fnv1a32', () => {
  it('matches the published FNV-1a 32-bit test vectors', () => {
    expect(fnv1a32('')).toBe(0x811c9dc5);
    expect(fnv1a32('a')).toBe(0xe40c292c);
    expect(fnv1a32('foobar')).toBe(0xbf9cf968);
  });

  it('hashes UTF-16 code units, not UTF-8 bytes', () => {
    // 'é' is U+00E9: one code unit 0xE9, but two UTF-8 bytes (0xC3 0xA9).
    const expected = Math.imul((0x811c9dc5 ^ 0xe9) >>> 0, 0x01000193) >>> 0;
    expect(fnv1a32('é')).toBe(expected);
    // A surrogate pair is two code units.
    let h = 0x811c9dc5;
    for (const unit of [0xd83c, 0xdf89]) h = Math.imul((h ^ unit) >>> 0, 0x01000193) >>> 0;
    expect(fnv1a32('🎉')).toBe(h);
  });
});

describe('responseShard', () => {
  it('is fnv1a32 modulo the shard count', () => {
    expect(RESPONSE_SHARDS).toBe(4);
    for (const id of ['', 'a', 'foobar', 'player_1-x', 'Zoë']) {
      expect(responseShard(id)).toBe(fnv1a32(id) % 4);
    }
    expect(responseShard('a')).toBe(0);
    expect(responseShard('')).toBe(1);
  });

  it('stays in range and spreads nanoid-style ids over all shards', () => {
    const alphabet = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_-';
    const counts = new Array<number>(RESPONSE_SHARDS).fill(0);
    let seed = 12345;
    const next = () => (seed = (Math.imul(seed, 1103515245) + 12345) >>> 0);
    for (let i = 0; i < 4000; i++) {
      let id = '';
      for (let j = 0; j < 21; j++) id += alphabet[next() % alphabet.length];
      const shard = responseShard(id);
      expect(shard).toBeGreaterThanOrEqual(0);
      expect(shard).toBeLessThan(RESPONSE_SHARDS);
      counts[shard] = (counts[shard] ?? 0) + 1;
    }
    for (const count of counts) expect(count).toBeGreaterThan(800);
  });
});

describe('key builders', () => {
  it('pads the slot to two digits and the question result index to three', () => {
    expect(responseSk('p1', 0)).toBe('P#p1#00');
    expect(responseSk('p1', 4)).toBe('P#p1#04');
    expect(responsePlayerPrefix('p1')).toBe('P#p1#');
    expect(resultKey('s', 7)).toEqual({ pk: 'SESS#s', sk: 'RESULT#007' });
    expect(resultKey('s', 100)).toEqual({ pk: 'SESS#s', sk: 'RESULT#100' });
  });

  it('places a response in its player shard', () => {
    const key = responseKey('sess', 3, 'player-a', 1);
    expect(key).toEqual({
      pk: `RESP#sess#3#${responseShard('player-a')}`,
      sk: 'P#player-a#01',
    });
  });

  it('pads createdAt to 13 digits', () => {
    expect(sessionGsiSk(1_234, 'sid')).toBe('SESS#0000000001234#sid');
    expect(sessionGsiSk(1_700_000_000_000, 'sid')).toBe('SESS#1700000000000#sid');
  });
});

describe('parseResponseId', () => {
  it('splits on the last dash', () => {
    expect(parseResponseId('abc-2')).toEqual({ playerId: 'abc', slot: 2 });
    expect(parseResponseId('a-b-c-0')).toEqual({ playerId: 'a-b-c', slot: 0 });
    expect(parseResponseId('_-x-10')).toEqual({ playerId: '_-x', slot: 10 });
    expect(parseResponseId('abc--1')).toEqual({ playerId: 'abc-', slot: 1 });
  });

  it('rejects ids that cannot name a response', () => {
    for (const id of ['', 'nodash', 'abc-', '-1', 'abc-x', 'abc-01', 'abc-1.5']) {
      expect(parseResponseId(id), id).toBeNull();
    }
  });
});
