import { describe, expect, it } from 'vitest';
import { LIMITS } from '@zqhoot/protocol';
import type { AnswerPayload, Question } from '@zqhoot/protocol';
import {
  buildEnded,
  buildHostSnapshot,
  buildLeaderboard,
  buildPlayerSnapshot,
  computeLiveStats,
  computeReveal,
  refreshModeration,
  revealFromStored,
} from '../src/index.ts';
import type { PlayerRecord, ResponseRecord, Scoreboard, SessionMeta } from '../src/index.ts';
import { NOW, accept, newSession, openAtIndex, opt, revealingAt } from './helpers.ts';

/** API Gateway WebSocket message limit (ADR-0004) and the budget for one stored result item. */
const WS_MESSAGE_LIMIT = 128 * 1024;
const STORED_RESULT_LIMIT = 350 * 1024;
const PLAYERS = 500;
const HOST_CAP = LIMITS.openRevealMax + 50;

const bytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).length;

const EMOJI_BASE = 0x1f600;
const EMOJI_COUNT = 80;

/** `length` four-byte characters that differ from every other seed's: the seed is spelled out in base 80. */
function emoji(length: number, seed: number): string {
  const chars: number[] = [];
  let rest = seed;
  for (let i = 0; i < length; i++) {
    chars.push(EMOJI_BASE + (i < 4 ? rest % EMOJI_COUNT : (i * 7) % EMOJI_COUNT));
    if (i < 4) rest = Math.floor(rest / EMOJI_COUNT);
  }
  return String.fromCodePoint(...chars);
}

/**
 * 16 flags: 16 graphemes, 64 UTF-16 units (the longest `nicknameRawMaxLength` allows) and 128
 * UTF-8 bytes, the heaviest emoji nickname. Not the heaviest nickname overall: an Indic conjunct
 * one, such as 'क्ष्मी' x 10 + 'किकि', is 64 units but 192 bytes, and a 500-player roster of those
 * can exceed the host.state budget by itself. The roster is not bounded in bytes yet.
 */
function flags(seed: number): string {
  const letter = (n: number) => String.fromCodePoint(0x1f1e6 + (n % 26));
  return Array.from(
    { length: LIMITS.nicknameMaxGraphemes },
    (_, i) => letter(seed + i) + letter(seed * 3 + i),
  ).join('');
}

const Q = { single: 0, poll: 1, wordcloud: 2, open: 3 } as const;

const questions: Question[] = [
  {
    id: 'q-single',
    type: 'single',
    prompt: 'p'.repeat(LIMITS.questionPromptMax),
    timeLimitSec: 20,
    options: [1, 2, 3, 4].map((n) => opt(`opt-${n}`, 'o'.repeat(LIMITS.optionTextMax))),
    correctOptionId: 'opt-1',
    points: 1,
  },
  {
    id: 'q-poll',
    type: 'poll',
    prompt: 'p'.repeat(LIMITS.questionPromptMax),
    timeLimitSec: null,
    options: [1, 2, 3, 4, 5, 6].map((n) => opt(`opt-${n}`, 'o'.repeat(LIMITS.optionTextMax))),
  },
  {
    id: 'q-wordcloud',
    type: 'wordcloud',
    prompt: 'One word',
    timeLimitSec: 30,
    maxEntries: LIMITS.wordEntriesMax,
  },
  {
    id: 'q-open',
    type: 'open',
    prompt: 'Tell us more',
    timeLimitSec: 60,
    maxEntries: LIMITS.openEntriesMax,
    requireApproval: true,
  },
];

const s = newSession(questions);

const text = (value: string): AnswerPayload => ({ kind: 'text', text: value });

describe.each([
  ['single-emoji nicknames', (n: number) => emoji(LIMITS.nicknameMaxGraphemes, n)],
  ['flag nicknames', flags],
])('message sizes at the maximum quiz limits: 500 players, %s', (_label, nicknameOf) => {
  const players: PlayerRecord[] = Array.from({ length: PLAYERS }, (_, n) => ({
    sessionId: s.meta.sessionId,
    // 21 characters, like the nanoid the service generates.
    playerId: `pl${String(n).padStart(4, '0')}${'a'.repeat(15)}`,
    nickname: nicknameOf(n),
    nicknameKey: `key-${n}`,
    tokenHash: 'hash',
    joinedAt: 100 + n,
    kicked: false,
    lastSeenAt: 100 + n,
  }));
  const connected = new Set(players.map((p) => p.playerId));

  /** Every player fills every entry the question allows, through the real evaluator. */
  function play(
    index: number,
    entries: number,
    payload: (n: number, slot: number) => AnswerPayload,
  ) {
    const meta = openAtIndex(s, index);
    return players.flatMap((p, n) => {
      const own: ResponseRecord[] = [];
      for (let slot = 0; slot < entries; slot++) {
        const at = (meta.openAt as number) + 100 + n;
        own.push(accept(s, meta, p.playerId, payload(n, slot), at, own));
      }
      return own;
    });
  }

  const singles = play(Q.single, 1, (n) => ({ kind: 'choice', optionId: `opt-${(n % 4) + 1}` }));
  const polls = play(Q.poll, 1, (n) => ({ kind: 'choice', optionId: `opt-${(n % 6) + 1}` }));
  const words = play(Q.wordcloud, LIMITS.wordEntriesMax, (n, slot) =>
    text(emoji(LIMITS.wordMaxLength, n * LIMITS.wordEntriesMax + slot)),
  );
  // A third of each status, so the host view fills both of its buckets.
  const opens = play(Q.open, LIMITS.openEntriesMax, (n, slot) =>
    text(emoji(LIMITS.openTextMax, n * LIMITS.openEntriesMax + slot)),
  ).map((r, i): ResponseRecord => ({
    ...r,
    status: (['visible', 'pending', 'hidden'] as const)[i % 3]!,
  }));

  const reveal = (index: number, responses: ResponseRecord[], prior: Scoreboard | null) =>
    computeReveal({
      meta: revealingAt(s, index),
      snapshot: s.snapshot,
      responses,
      players,
      scoreboard: prior,
      now: NOW + 99_000,
    });

  const scored = reveal(Q.single, singles, null);

  it('uses answers at the limits it claims to', () => {
    expect(opens).toHaveLength(PLAYERS * LIMITS.openEntriesMax);
    expect(new Set(opens.map((r) => r.normalizedText)).size).toBe(opens.length);
    for (const r of opens) {
      const answer = r.normalizedText as string;
      expect(Array.from(answer)).toHaveLength(LIMITS.openTextMax);
      expect(new TextEncoder().encode(answer)).toHaveLength(LIMITS.openTextMax * 4);
    }
    expect(new Set(words.map((r) => r.normalizedText)).size).toBe(words.length);
    for (const p of players) {
      expect(Array.from(new Intl.Segmenter().segment(p.nickname))).toHaveLength(
        LIMITS.nicknameMaxGraphemes,
      );
      expect(p.nickname.length).toBeLessThanOrEqual(LIMITS.nicknameRawMaxLength);
    }
  });

  const cases = [
    { name: 'open-ended', index: Q.open, responses: opens },
    { name: 'word cloud', index: Q.wordcloud, responses: words },
    { name: '6-option poll', index: Q.poll, responses: polls },
    { name: 'single choice', index: Q.single, responses: singles },
  ];

  describe.each(cases)('$name reveal', ({ index, responses }) => {
    const out = reveal(index, responses, index === Q.single ? null : scored.scoreboard);
    const hostSnapshot = (meta: SessionMeta, result = out.stored) =>
      buildHostSnapshot({
        meta,
        snapshot: s.snapshot,
        players,
        connectedPlayerIds: connected,
        scoreboard: out.scoreboard,
        result,
      });

    it('keeps every player reveal under the WebSocket limit', () => {
      expect(out.playerMessages).toHaveLength(PLAYERS);
      for (const m of out.playerMessages) expect(bytes(m.message)).toBeLessThan(WS_MESSAGE_LIMIT);
    });

    it('keeps every reveal rebuilt from the stored result under the limit', () => {
      const again = revealFromStored({ meta: revealingAt(s, index), stored: out.stored, players });
      for (const m of again.playerMessages) expect(bytes(m.message)).toBeLessThan(WS_MESSAGE_LIMIT);
    });

    it('keeps every player snapshot in reveal under the limit', () => {
      for (const p of players) {
        const snapshot = buildPlayerSnapshot({
          meta: out.meta,
          snapshot: s.snapshot,
          player: p,
          players,
          scoreboard: out.scoreboard,
          responses: responses.filter((r) => r.playerId === p.playerId),
          result: out.stored,
        });
        expect(bytes(snapshot)).toBeLessThan(WS_MESSAGE_LIMIT);
      }
    });

    it('keeps the host.state snapshot in reveal under the limit', () => {
      const message = {
        type: 'host.state',
        sv: out.meta.version,
        ts: NOW,
        snapshot: hostSnapshot(out.meta),
      };
      expect(bytes(message)).toBeLessThan(WS_MESSAGE_LIMIT);
    });

    it('keeps the stored result under the item budget', () => {
      expect(bytes(out.stored)).toBeLessThan(STORED_RESULT_LIMIT);
    });
  });

  describe('open-ended reveal', () => {
    const out = reveal(Q.open, opens, scored.scoreboard);
    const host = out.stored.result;
    if (host.type !== 'open') throw new Error('expected an open result');

    it('stores the newest visible responses and the newest pending or hidden ones', () => {
      expect(host.responses).toHaveLength(HOST_CAP);
      const visible = host.responses.filter((r) => r.status === 'visible');
      expect(visible).toHaveLength(LIMITS.openRevealMax);
      expect(host.responses.length - visible.length).toBe(50);
      expect(host.omitted).toBe(opens.length - HOST_CAP);
      const newestVisible = opens
        .filter((r) => r.status === 'visible')
        .sort((a, b) => b.receivedAt - a.receivedAt || b.responseId.localeCompare(a.responseId))
        .slice(0, LIMITS.openRevealMax);
      expect(new Set(visible.map((r) => r.id))).toEqual(
        new Set(newestVisible.map((r) => r.responseId)),
      );
    });

    it('sends players no responses, only the number of visible ones', () => {
      const visible = opens.filter((r) => r.status === 'visible').length;
      for (const m of out.playerMessages) {
        expect(m.message).toMatchObject({
          type: 'reveal',
          result: { responses: [], omitted: visible },
        });
      }
    });

    it('shows the presenter what fits and says how many it left out', () => {
      const snapshot = buildHostSnapshot({
        meta: out.meta,
        snapshot: s.snapshot,
        players,
        connectedPlayerIds: connected,
        scoreboard: out.scoreboard,
        result: out.stored,
      });
      const shown = snapshot.result;
      if (shown?.type !== 'open') throw new Error('expected an open result');
      expect(shown.responses.length).toBeGreaterThan(0);
      expect(shown.responses.length + (shown.omitted ?? 0)).toBe(opens.length);
      // What is left is the newest tail of the stored list, still oldest first.
      expect(shown.responses).toEqual(
        host.responses.slice(host.responses.length - shown.responses.length),
      );
    });

    it('caps a moderation rebuild the same way', () => {
      const refreshed = refreshModeration({ stored: out.stored, players, responses: opens });
      expect(refreshed?.result).toEqual(out.stored.result);
      expect(bytes(refreshed)).toBeLessThan(STORED_RESULT_LIMIT);
    });

    it('keeps a live-stats page under the WebSocket limit', () => {
      const stats = computeLiveStats({
        question: questions[Q.open] as Question,
        responses: opens,
        players,
      });
      expect(stats.type === 'open' && stats.responses).toHaveLength(LIMITS.statsResponsesPage);
      expect(bytes({ type: 'stats', questionIndex: Q.open, ts: NOW, stats })).toBeLessThan(
        WS_MESSAGE_LIMIT,
      );
    });
  });

  it('caps the word cloud at the top N words', () => {
    const out = reveal(Q.wordcloud, words, scored.scoreboard);
    expect(out.hostResult.type === 'wordcloud' && out.hostResult.words).toHaveLength(
      LIMITS.wordCloudTopN,
    );
    const stats = computeLiveStats({
      question: questions[Q.wordcloud] as Question,
      responses: words,
      players,
    });
    expect(stats.type === 'wordcloud' && stats.words).toHaveLength(LIMITS.wordCloudTopN);
  });

  it('keeps leaderboard and ended messages under the WebSocket limit', () => {
    const board = scored.scoreboard;
    const leaderboard = buildLeaderboard({ meta: scored.meta, scoreboard: board, players });
    const ended = buildEnded({
      meta: scored.meta,
      snapshot: s.snapshot,
      scoreboard: board,
      players,
    });
    expect(leaderboard.playerMessages).toHaveLength(PLAYERS);
    expect(ended.playerMessages).toHaveLength(PLAYERS);
    for (const m of [...leaderboard.playerMessages, ...ended.playerMessages]) {
      expect(bytes(m.message)).toBeLessThan(WS_MESSAGE_LIMIT);
    }
  });
});
