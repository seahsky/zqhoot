import { describe, expect, it } from 'vitest';
import {
  AnswerAckMsg,
  ClientMessage,
  ErrorMsg,
  LIMITS,
  PROTOCOL_VERSION,
  PublicQuestion,
  ServerMessage,
} from '../src/index.ts';
import type { ClientMessageType, ServerMessageType } from '../src/index.ts';
import {
  OPT_A,
  PID,
  SID,
  entry,
  fullQuestion,
  hostSnapshot,
  outcome,
  playerSnapshot,
  publicQuestion,
  revealSnapshot,
  singleResult,
} from './fixtures.ts';

type Cases = { valid: unknown[]; invalid: Array<[string, unknown]> };

const token = 't'.repeat(43);

const clientCases: Record<ClientMessageType, Cases> = {
  join: {
    valid: [
      { type: 'join', v: 1, pin: '123456', nickname: 'Ana' },
      { type: 'join', v: 1, pin: '000000', nickname: '' },
      { type: 'join', v: 1, pin: '123456', nickname: 'x'.repeat(64) },
    ],
    invalid: [
      ['wrong protocol version', { type: 'join', v: 2, pin: '123456', nickname: 'Ana' }],
      ['missing version', { type: 'join', pin: '123456', nickname: 'Ana' }],
      ['short pin', { type: 'join', v: 1, pin: '12345', nickname: 'Ana' }],
      ['long pin', { type: 'join', v: 1, pin: '1234567', nickname: 'Ana' }],
      ['non-numeric pin', { type: 'join', v: 1, pin: 'abcdef', nickname: 'Ana' }],
      ['numeric pin', { type: 'join', v: 1, pin: 123456, nickname: 'Ana' }],
      ['missing nickname', { type: 'join', v: 1, pin: '123456' }],
      [
        'nickname over the raw cap',
        { type: 'join', v: 1, pin: '123456', nickname: 'x'.repeat(65) },
      ],
      ['nickname not a string', { type: 'join', v: 1, pin: '123456', nickname: 7 }],
    ],
  },
  resume: {
    valid: [{ type: 'resume', v: 1, sessionId: SID, playerId: PID, token }],
    invalid: [
      ['wrong version', { type: 'resume', v: 0, sessionId: SID, playerId: PID, token }],
      [
        'short token',
        { type: 'resume', v: 1, sessionId: SID, playerId: PID, token: 't'.repeat(19) },
      ],
      [
        'long token',
        { type: 'resume', v: 1, sessionId: SID, playerId: PID, token: 't'.repeat(129) },
      ],
      ['bad session id', { type: 'resume', v: 1, sessionId: 'short', playerId: PID, token }],
      ['bad player id', { type: 'resume', v: 1, sessionId: SID, playerId: 'has space', token }],
      ['missing token', { type: 'resume', v: 1, sessionId: SID, playerId: PID }],
    ],
  },
  'host.hello': {
    valid: [
      { type: 'host.hello', v: 1, sessionId: SID, client: 'control', authToken: 'a.b.c' },
      { type: 'host.hello', v: 1, sessionId: SID, client: 'present', authToken: 'a'.repeat(4096) },
    ],
    invalid: [
      [
        'wrong version',
        { type: 'host.hello', v: 3, sessionId: SID, client: 'control', authToken: 'a' },
      ],
      [
        'unknown client',
        { type: 'host.hello', v: 1, sessionId: SID, client: 'admin', authToken: 'a' },
      ],
      [
        'empty token',
        { type: 'host.hello', v: 1, sessionId: SID, client: 'control', authToken: '' },
      ],
      [
        'oversized token',
        {
          type: 'host.hello',
          v: 1,
          sessionId: SID,
          client: 'control',
          authToken: 'a'.repeat(4097),
        },
      ],
      ['missing session', { type: 'host.hello', v: 1, client: 'control', authToken: 'a' }],
    ],
  },
  answer: {
    valid: [
      { type: 'answer', questionIndex: 0, payload: { kind: 'choice', optionId: OPT_A } },
      { type: 'answer', questionIndex: 99, payload: { kind: 'boolean', value: false } },
      { type: 'answer', questionIndex: 3, payload: { kind: 'text', text: 'hello' } },
      { type: 'answer', questionIndex: 3, payload: { kind: 'rating', value: 10 } },
    ],
    invalid: [
      [
        'negative index',
        { type: 'answer', questionIndex: -1, payload: { kind: 'boolean', value: true } },
      ],
      [
        'index past the quiz cap',
        { type: 'answer', questionIndex: 100, payload: { kind: 'boolean', value: true } },
      ],
      [
        'fractional index',
        { type: 'answer', questionIndex: 1.5, payload: { kind: 'boolean', value: true } },
      ],
      ['missing payload', { type: 'answer', questionIndex: 0 }],
      [
        'unknown payload kind',
        { type: 'answer', questionIndex: 0, payload: { kind: 'slider', value: 1 } },
      ],
      [
        'bad option id',
        { type: 'answer', questionIndex: 0, payload: { kind: 'choice', optionId: 'x' } },
      ],
      [
        'non-boolean value',
        { type: 'answer', questionIndex: 0, payload: { kind: 'boolean', value: 'true' } },
      ],
      ['empty text', { type: 'answer', questionIndex: 0, payload: { kind: 'text', text: '' } }],
      [
        'text over the limit',
        { type: 'answer', questionIndex: 0, payload: { kind: 'text', text: 'a'.repeat(201) } },
      ],
      ['rating zero', { type: 'answer', questionIndex: 0, payload: { kind: 'rating', value: 0 } }],
      [
        'rating past the scale cap',
        { type: 'answer', questionIndex: 0, payload: { kind: 'rating', value: 11 } },
      ],
      [
        'fractional rating',
        { type: 'answer', questionIndex: 0, payload: { kind: 'rating', value: 2.5 } },
      ],
    ],
  },
  ping: {
    valid: [
      { type: 'ping', t: 0 },
      { type: 'ping', t: 1_700_000_000_000.25 },
    ],
    invalid: [
      ['missing t', { type: 'ping' }],
      ['string t', { type: 'ping', t: '1' }],
    ],
  },
  leave: {
    valid: [{ type: 'leave' }],
    invalid: [['wrong case', { type: 'Leave' }]],
  },
  'host.next': {
    valid: [
      { type: 'host.next', from: { phase: 'lobby', questionIndex: -1 } },
      { type: 'host.next', from: { phase: 'reveal', questionIndex: 12 } },
    ],
    invalid: [
      ['missing from', { type: 'host.next' }],
      ['unknown phase', { type: 'host.next', from: { phase: 'paused', questionIndex: 0 } }],
      ['index below -1', { type: 'host.next', from: { phase: 'lobby', questionIndex: -2 } }],
      ['fractional index', { type: 'host.next', from: { phase: 'question', questionIndex: 0.5 } }],
      ['missing index', { type: 'host.next', from: { phase: 'question' } }],
    ],
  },
  'host.close': {
    valid: [
      { type: 'host.close', questionIndex: 0, reason: 'manual' },
      { type: 'host.close', questionIndex: 4, reason: 'timer' },
      { type: 'host.close', questionIndex: 4, reason: 'all-answered' },
    ],
    invalid: [
      ['unknown reason', { type: 'host.close', questionIndex: 0, reason: 'auto' }],
      ['missing reason', { type: 'host.close', questionIndex: 0 }],
      ['index past the cap', { type: 'host.close', questionIndex: 100, reason: 'manual' }],
    ],
  },
  'host.skip': {
    valid: [{ type: 'host.skip', questionIndex: 2 }],
    invalid: [
      ['missing index', { type: 'host.skip' }],
      ['negative index', { type: 'host.skip', questionIndex: -1 }],
    ],
  },
  'host.end': {
    valid: [{ type: 'host.end' }],
    invalid: [['wrong type', { type: 'host.finish' }]],
  },
  'host.kick': {
    valid: [{ type: 'host.kick', playerId: PID }],
    invalid: [
      ['short id', { type: 'host.kick', playerId: 'p1' }],
      ['missing id', { type: 'host.kick' }],
    ],
  },
  'host.lock': {
    valid: [
      { type: 'host.lock', locked: true },
      { type: 'host.lock', locked: false },
    ],
    invalid: [
      ['string flag', { type: 'host.lock', locked: 'yes' }],
      ['missing flag', { type: 'host.lock' }],
    ],
  },
  'host.moderate': {
    valid: [
      { type: 'host.moderate', questionIndex: 4, responseId: `${PID}-0`, status: 'visible' },
      { type: 'host.moderate', questionIndex: 4, responseId: `${PID}-1`, status: 'hidden' },
    ],
    invalid: [
      [
        'pending is not a host choice',
        { type: 'host.moderate', questionIndex: 4, responseId: `${PID}-0`, status: 'pending' },
      ],
      ['missing response id', { type: 'host.moderate', questionIndex: 4, status: 'visible' }],
      [
        'bad response id',
        { type: 'host.moderate', questionIndex: 4, responseId: '!', status: 'visible' },
      ],
    ],
  },
  'host.stats': {
    valid: [
      { type: 'host.stats', questionIndex: 1 },
      { type: 'host.stats', questionIndex: 1, after: 'a'.repeat(200) },
    ],
    invalid: [
      ['cursor over the cap', { type: 'host.stats', questionIndex: 1, after: 'a'.repeat(201) }],
      ['negative index', { type: 'host.stats', questionIndex: -1 }],
      ['numeric cursor', { type: 'host.stats', questionIndex: 1, after: 5 }],
    ],
  },
};

const ts = 1_700_000_000_000;
const leaderboardYou = { score: 900, rank: 1 };
const finalYou = { score: 900, rank: 1, correct: 3, answeredScored: 4, scoredQuestions: 5 };

const serverCases: Record<ServerMessageType, Cases> = {
  welcome: {
    valid: [
      {
        type: 'welcome',
        ts,
        role: 'player',
        credentials: { sessionId: SID, playerId: PID, token },
        snapshot: playerSnapshot,
      },
      { type: 'welcome', ts, role: 'player', snapshot: playerSnapshot },
      { type: 'welcome', ts, role: 'player', snapshot: revealSnapshot },
      {
        type: 'welcome',
        ts,
        role: 'player',
        snapshot: { ...revealSnapshot, reveal: { ...revealSnapshot.reveal, question: undefined } },
      },
      { type: 'welcome', ts, role: 'host', snapshot: hostSnapshot },
    ],
    invalid: [
      [
        'reveal question that is not a public question',
        {
          type: 'welcome',
          ts,
          role: 'player',
          snapshot: {
            ...revealSnapshot,
            reveal: { ...revealSnapshot.reveal, question: { ...fullQuestion, type: 'essay' } },
          },
        },
      ],
      ['unknown role', { type: 'welcome', ts, role: 'spectator', snapshot: playerSnapshot }],
      [
        'host role with a player snapshot',
        { type: 'welcome', ts, role: 'host', snapshot: playerSnapshot },
      ],
      [
        'player role with a host snapshot',
        { type: 'welcome', ts, role: 'player', snapshot: hostSnapshot },
      ],
      ['missing snapshot', { type: 'welcome', ts, role: 'player' }],
      ['missing ts', { type: 'welcome', role: 'player', snapshot: playerSnapshot }],
      [
        'incomplete credentials',
        {
          type: 'welcome',
          ts,
          role: 'player',
          credentials: { sessionId: SID },
          snapshot: playerSnapshot,
        },
      ],
    ],
  },
  error: {
    valid: [
      { type: 'error', ts, code: 'bad-request', message: 'nope' },
      { type: 'error', ts, code: 'protocol-version', message: 'old client', ref: 'join' },
    ],
    invalid: [
      ['unknown code', { type: 'error', ts, code: 'teapot', message: 'x' }],
      ['missing message', { type: 'error', ts, code: 'internal' }],
      ['numeric ref', { type: 'error', ts, code: 'internal', message: 'x', ref: 3 }],
    ],
  },
  pong: {
    valid: [{ type: 'pong', ts, t: 123 }],
    invalid: [
      ['missing t', { type: 'pong', ts }],
      ['negative ts', { type: 'pong', ts: -1, t: 1 }],
      ['fractional ts', { type: 'pong', ts: 1.5, t: 1 }],
    ],
  },
  'host.state': {
    valid: [{ type: 'host.state', ts, snapshot: hostSnapshot }],
    invalid: [
      ['bad pin', { type: 'host.state', ts, snapshot: { ...hostSnapshot, pin: '12' } }],
      ['bad phase', { type: 'host.state', ts, snapshot: { ...hostSnapshot, phase: 'paused' } }],
      ['missing snapshot', { type: 'host.state', ts }],
    ],
  },
  roster: {
    valid: [
      {
        type: 'roster',
        ts,
        upsert: [{ playerId: PID, nickname: 'Ana', connected: false }],
        removed: [],
      },
      { type: 'roster', ts, upsert: [], removed: [PID] },
    ],
    invalid: [
      [
        'bad entry',
        { type: 'roster', ts, upsert: [{ playerId: PID, nickname: 'Ana' }], removed: [] },
      ],
      ['bad removed id', { type: 'roster', ts, upsert: [], removed: ['x'] }],
      ['missing removed', { type: 'roster', ts, upsert: [] }],
    ],
  },
  stats: {
    valid: [
      {
        type: 'stats',
        ts,
        questionIndex: 0,
        stats: { type: 'single', answered: 1, totalPlayers: 2, counts: { [OPT_A]: 1 } },
      },
      {
        type: 'stats',
        ts,
        questionIndex: 4,
        stats: { type: 'open', answered: 0, totalPlayers: 2, responses: [], cursor: null },
      },
      {
        type: 'stats',
        ts,
        questionIndex: 3,
        stats: {
          type: 'wordcloud',
          answered: 1,
          totalPlayers: 2,
          words: [{ text: 'sun', count: 1 }],
        },
      },
    ],
    invalid: [
      [
        'open without cursor',
        {
          type: 'stats',
          ts,
          questionIndex: 4,
          stats: { type: 'open', answered: 0, totalPlayers: 2, responses: [] },
        },
      ],
      [
        'shape does not match type',
        {
          type: 'stats',
          ts,
          questionIndex: 0,
          stats: { type: 'single', answered: 1, totalPlayers: 2, words: [] },
        },
      ],
      [
        'index past the cap',
        {
          type: 'stats',
          ts,
          questionIndex: 100,
          stats: { type: 'single', answered: 1, totalPlayers: 2, counts: {} },
        },
      ],
    ],
  },
  question: {
    valid: [
      {
        type: 'question',
        ts,
        sv: 4,
        index: 0,
        total: 5,
        question: publicQuestion,
        openAt: ts + 1500,
        deadline: ts + 21_500,
      },
      {
        type: 'question',
        ts,
        sv: 4,
        index: 2,
        total: 5,
        question: { ...publicQuestion, timeLimitSec: null },
        openAt: ts + 1500,
        deadline: null,
      },
    ],
    invalid: [
      [
        'missing openAt',
        {
          type: 'question',
          ts,
          sv: 4,
          index: 0,
          total: 5,
          question: publicQuestion,
          deadline: null,
        },
      ],
      [
        'missing deadline',
        { type: 'question', ts, sv: 4, index: 0, total: 5, question: publicQuestion, openAt: ts },
      ],
      [
        'question with an unknown type',
        {
          type: 'question',
          ts,
          sv: 4,
          index: 0,
          total: 5,
          question: { ...publicQuestion, type: 'slider' },
          openAt: ts,
          deadline: null,
        },
      ],
      [
        'single question without options',
        {
          type: 'question',
          ts,
          sv: 4,
          index: 0,
          total: 5,
          question: { id: 'q-single', type: 'single', timeLimitSec: 5, points: 1 },
          openAt: ts,
          deadline: null,
        },
      ],
    ],
  },
  'answer.ack': {
    valid: [
      { type: 'answer.ack', ts, index: 0, status: 'accepted', entries: 1 },
      { type: 'answer.ack', ts, index: 0, status: 'duplicate', entries: 1 },
      { type: 'answer.ack', ts, index: 0, status: 'rejected', reason: 'too-late', entries: 0 },
    ],
    invalid: [
      ['unknown status', { type: 'answer.ack', ts, index: 0, status: 'ok', entries: 1 }],
      [
        'unknown reason',
        { type: 'answer.ack', ts, index: 0, status: 'rejected', reason: 'slow', entries: 0 },
      ],
      [
        'fractional entries',
        { type: 'answer.ack', ts, index: 0, status: 'accepted', entries: 0.5 },
      ],
      ['missing entries', { type: 'answer.ack', ts, index: 0, status: 'accepted' }],
    ],
  },
  reveal: {
    valid: [
      { type: 'reveal', ts, sv: 5, index: 0, result: singleResult, you: outcome },
      {
        type: 'reveal',
        ts,
        sv: 5,
        index: 0,
        result: singleResult,
        you: { ...outcome, correct: undefined, rank: null },
      },
      // Players get no responses, only how many were visible; hosts may omit the count.
      {
        type: 'reveal',
        ts,
        sv: 5,
        index: 0,
        result: { type: 'open', answered: 2, totalPlayers: 4, responses: [], omitted: 2 },
        you: outcome,
      },
      {
        type: 'reveal',
        ts,
        sv: 5,
        index: 0,
        result: { type: 'open', answered: 2, totalPlayers: 4, responses: [] },
        you: outcome,
      },
    ],
    invalid: [
      ['missing you', { type: 'reveal', ts, sv: 5, index: 0, result: singleResult }],
      [
        'negative omitted count',
        {
          type: 'reveal',
          ts,
          sv: 5,
          index: 0,
          result: { type: 'open', answered: 2, totalPlayers: 4, responses: [], omitted: -1 },
          you: outcome,
        },
      ],
      [
        'fractional omitted count',
        {
          type: 'reveal',
          ts,
          sv: 5,
          index: 0,
          result: { type: 'open', answered: 2, totalPlayers: 4, responses: [], omitted: 1.5 },
          you: outcome,
        },
      ],
      [
        'single result without the answer',
        {
          type: 'reveal',
          ts,
          sv: 5,
          index: 0,
          result: { ...singleResult, correctOptionId: undefined },
          you: outcome,
        },
      ],
      [
        'fractional points',
        {
          type: 'reveal',
          ts,
          sv: 5,
          index: 0,
          result: singleResult,
          you: { ...outcome, points: 1.5 },
        },
      ],
    ],
  },
  leaderboard: {
    valid: [
      { type: 'leaderboard', ts, sv: 6, index: 0, entries: [entry], you: leaderboardYou },
      {
        type: 'leaderboard',
        ts,
        sv: 6,
        index: 0,
        entries: [],
        you: { score: 0, rank: null, behind: { nickname: 'Bo', points: 100 } },
      },
    ],
    invalid: [
      [
        'rank below 1',
        {
          type: 'leaderboard',
          ts,
          sv: 6,
          index: 0,
          entries: [{ ...entry, rank: 0 }],
          you: leaderboardYou,
        },
      ],
      ['missing you', { type: 'leaderboard', ts, sv: 6, index: 0, entries: [entry] }],
      [
        'incomplete behind',
        {
          type: 'leaderboard',
          ts,
          sv: 6,
          index: 0,
          entries: [],
          you: { score: 1, rank: 1, behind: { nickname: 'Bo' } },
        },
      ],
    ],
  },
  ended: {
    valid: [
      { type: 'ended', ts, sv: 9, podium: [entry], totalPlayers: 4, you: finalYou },
      { type: 'ended', ts, sv: 9, podium: [], totalPlayers: 0, you: { ...finalYou, rank: null } },
    ],
    invalid: [
      ['missing totalPlayers', { type: 'ended', ts, sv: 9, podium: [], you: finalYou }],
      [
        'missing final tallies',
        { type: 'ended', ts, sv: 9, podium: [], totalPlayers: 1, you: { score: 1, rank: 1 } },
      ],
    ],
  },
  kicked: {
    valid: [{ type: 'kicked', ts }],
    invalid: [['missing ts', { type: 'kicked' }]],
  },
};

describe('protocol version', () => {
  it('is 1', () => {
    expect(PROTOCOL_VERSION).toBe(1);
  });
});

describe('ClientMessage', () => {
  it('has a case table entry for every message type in the schema', () => {
    const types = ClientMessage.options.map((o) => o.shape.type.value).sort();
    expect(types).toEqual(Object.keys(clientCases).sort());
  });

  describe.each(Object.entries(clientCases))('%s', (type, { valid, invalid }) => {
    it.each(valid.map((m, i) => [i, m] as const))('accepts valid sample %i', (_i, message) => {
      expect((message as { type: string }).type).toBe(type);
      expect(ClientMessage.safeParse(message).success).toBe(true);
    });

    it.each(invalid)('rejects %s', (_name, message) => {
      expect(ClientMessage.safeParse(message).success).toBe(false);
    });
  });

  it('rejects things that are not messages', () => {
    for (const junk of [
      null,
      undefined,
      42,
      'join',
      [],
      {},
      { type: 'unknown' },
      { type: 5 },
      { kind: 'ping', t: 1 },
    ]) {
      expect(ClientMessage.safeParse(junk).success).toBe(false);
    }
  });

  it('accepts unknown extra keys so newer clients keep working (ADR-0004)', () => {
    const parsed = ClientMessage.safeParse({ type: 'ping', t: 1, future: 'field' });
    expect(parsed.success).toBe(true);
  });

  it('keeps every client message within the size cap at its largest legal size', () => {
    const size = (m: unknown) => new TextEncoder().encode(JSON.stringify(m)).length;
    const worst = [
      { type: 'join', v: 1, pin: '123456', nickname: '€'.repeat(64) },
      {
        type: 'resume',
        v: 1,
        sessionId: 's'.repeat(32),
        playerId: 'p'.repeat(32),
        token: 't'.repeat(128),
      },
      { type: 'answer', questionIndex: 99, payload: { kind: 'text', text: '€'.repeat(200) } },
      { type: 'host.moderate', questionIndex: 99, responseId: 'r'.repeat(32), status: 'visible' },
      { type: 'host.stats', questionIndex: 99, after: 'a'.repeat(200) },
      {
        type: 'host.hello',
        v: 1,
        sessionId: 's'.repeat(32),
        client: 'present',
        authToken: 'a'.repeat(3900),
      },
    ];
    for (const m of worst) {
      expect(ClientMessage.safeParse(m).success).toBe(true);
      expect(size(m), (m as { type: string }).type).toBeLessThanOrEqual(
        LIMITS.clientMessageMaxBytes,
      );
    }
  });
});

describe('ServerMessage', () => {
  it('has a case table entry for every message type', () => {
    expect(Object.keys(serverCases).sort()).toEqual(
      [
        'answer.ack',
        'ended',
        'error',
        'host.state',
        'kicked',
        'leaderboard',
        'pong',
        'question',
        'reveal',
        'roster',
        'stats',
        'welcome',
      ].sort(),
    );
  });

  describe.each(Object.entries(serverCases))('%s', (type, { valid, invalid }) => {
    it.each(valid.map((m, i) => [i, m] as const))('accepts valid sample %i', (_i, message) => {
      expect((message as { type: string }).type).toBe(type);
      const parsed = ServerMessage.safeParse(message);
      expect(parsed.success, JSON.stringify(parsed.error?.issues)).toBe(true);
    });

    it.each(invalid)('rejects %s', (_name, message) => {
      expect(ServerMessage.safeParse(message).success).toBe(false);
    });
  });

  it('rejects things that are not messages', () => {
    for (const junk of [null, 1, 'pong', [], {}, { type: 'nope', ts }]) {
      expect(ServerMessage.safeParse(junk).success).toBe(false);
    }
  });

  it('exposes the standalone schemas the server builds messages from', () => {
    expect(ErrorMsg.safeParse({ type: 'error', ts, code: 'internal', message: 'x' }).success).toBe(
      true,
    );
    expect(
      AnswerAckMsg.safeParse({ type: 'answer.ack', ts, index: 0, status: 'accepted', entries: 1 })
        .success,
    ).toBe(true);
  });

  it('strips answer fields from a public question at the boundary', () => {
    const parsed = PublicQuestion.parse({ ...fullQuestion, correct: true, requireApproval: true });
    expect(JSON.stringify(parsed)).not.toContain('correctOptionId');
    expect(JSON.stringify(parsed)).not.toContain('"correct"');
    expect(JSON.stringify(parsed)).not.toContain('requireApproval');
  });

  it('keeps the biggest server message (host snapshot, 400 players) under the 32 KB frame limit', () => {
    const roster = Array.from({ length: 400 }, (_, i) => ({
      playerId: `player-${String(i).padStart(4, '0')}`,
      nickname: `Nickname${String(i).padStart(4, '0')}`,
      connected: i % 2 === 0,
    }));
    const message = {
      type: 'host.state',
      ts,
      snapshot: {
        ...hostSnapshot,
        phase: 'leaderboard',
        roster,
        leaderboard: roster
          .slice(0, 10)
          .map((p, i) => ({ ...p, score: 1000 - i, rank: i + 1, delta: 5 })),
      },
    };
    expect(ServerMessage.safeParse(message).success).toBe(true);
    expect(new TextEncoder().encode(JSON.stringify(message)).length).toBeLessThan(32 * 1024);
  });
});
