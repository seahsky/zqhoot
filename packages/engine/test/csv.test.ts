import { describe, expect, it } from 'vitest';
import type { AnswerPayload } from '@zqhoot/protocol';
import { buildResultsCsv, computeReveal } from '../src/index.ts';
import type {
  PlayerRecord,
  ResponseRecord,
  Scoreboard,
  StoredQuestionResult,
} from '../src/index.ts';
import {
  NOW,
  Q,
  accept,
  newSession,
  openAtIndex,
  pid,
  player,
  questions,
  revealingAt,
} from './helpers.ts';

const HEADER =
  'question_no,question_type,question,nickname,player_id,answered,response,correct,points,streak_bonus,response_time_ms,moderation,final_score,final_rank';

/** Minimal RFC 4180 reader: proves quoting round-trips instead of string-matching it. */
function parseCsv(csv: string): string[][] {
  const body = csv.startsWith('﻿') ? csv.slice(1) : csv;
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < body.length; i++) {
    const c = body[i] as string;
    if (quoted) {
      if (c === '"' && body[i + 1] === '"') {
        field += '"';
        i++;
      } else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') {
      row.push(field);
      field = '';
    } else if (c === '\r' && body[i + 1] === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
      i++;
    } else field += c;
  }
  if (field !== '' || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

const choice = (optionId: string): AnswerPayload => ({ kind: 'choice', optionId });
const text = (t: string): AnswerPayload => ({ kind: 'text', text: t });

type Column =
  | 'question_no'
  | 'question_type'
  | 'question'
  | 'nickname'
  | 'player_id'
  | 'answered'
  | 'response'
  | 'correct'
  | 'points'
  | 'streak_bonus'
  | 'response_time_ms'
  | 'moderation'
  | 'final_score'
  | 'final_rank';
type Row = Record<Column, string>;

interface Built {
  csv: string;
  rows: Row[];
}

function scenario(
  over: {
    nicknames?: string[];
    session?: ReturnType<typeof newSession>;
    skipped?: number[];
    openText?: string;
  } = {},
) {
  const s = over.session ?? newSession();
  const names = over.nicknames ?? ['Alice', 'Bob', 'Cara', 'Eve'];
  const players: PlayerRecord[] = names.map((nickname, i) =>
    player(i + 1, { nickname, kicked: nickname === 'Eve' }),
  );
  const results: StoredQuestionResult[] = [];
  const responsesByQuestion: ResponseRecord[][] = [];
  let scoreboard: Scoreboard | null = null;

  const run = (index: number, answers: Array<[number, AnswerPayload, number]>) => {
    const open = openAtIndex(s, index);
    const byPlayer = new Map<number, ResponseRecord[]>();
    const responses: ResponseRecord[] = [];
    for (const [no, payload, elapsed] of answers) {
      const existing = byPlayer.get(no) ?? [];
      const r = accept(s, open, pid(no), payload, (open.openAt as number) + elapsed, existing);
      byPlayer.set(no, [...existing, r]);
      responses.push(r);
    }
    const out = computeReveal({
      meta: revealingAt(s, index),
      snapshot: s.snapshot,
      responses,
      players,
      scoreboard,
      now: NOW + 100_000,
    });
    scoreboard = out.scoreboard;
    results.push(out.stored);
    responsesByQuestion[index] = responses;
  };

  run(Q.single, [
    [1, choice('opt-paris'), 0],
    [2, choice('opt-rome'), 1234],
    [4, choice('opt-paris'), 0], // kicked
  ]);
  run(Q.poll, [[1, choice('opt-blue'), 0]]);
  run(Q.wordcloud, [
    [1, text('Sunshine'), 100],
    [1, text('rain'), 200],
    [2, text('fuck'), 300],
  ]);
  run(Q.open, [
    [1, text(over.openText ?? 'Line one,\nline "two"'), 400],
    [2, text('=1+1'), 500],
  ]);
  run(Q.rating, [[2, { kind: 'rating', value: 4 }, 600]]);

  const meta = { ...s.meta, skipped: over.skipped ?? [] };
  const build = (patch: Partial<Parameters<typeof buildResultsCsv>[0]> = {}): Built => {
    const csv = buildResultsCsv({
      meta,
      snapshot: s.snapshot,
      players,
      scoreboard,
      results,
      responsesByQuestion,
      ...patch,
    });
    const [head, ...rest] = parseCsv(csv);
    return {
      csv,
      rows: rest.map(
        (r) => Object.fromEntries((head as string[]).map((h, i) => [h, r[i] ?? ''])) as Row,
      ),
    };
  };
  return { s, players, results, responsesByQuestion, scoreboard: () => scoreboard, build, meta };
}

describe('buildResultsCsv: format', () => {
  const { build } = scenario();
  const { csv } = build();

  it('starts with a UTF-8 BOM and the fixed header', () => {
    expect(csv.charCodeAt(0)).toBe(0xfeff);
    expect(csv.slice(1).split('\r\n')[0]).toBe(HEADER);
  });

  it('terminates every record with CRLF and uses no bare line feeds outside quoted fields', () => {
    expect(csv.endsWith('\r\n')).toBe(true);
    const unquoted = csv.replace(/"(?:[^"]|"")*"/g, '');
    expect(unquoted).not.toMatch(/(^|[^\r])\n/);
    expect(unquoted).not.toMatch(/\r(?!\n)/);
  });

  it('has the same number of fields on every row', () => {
    for (const row of parseCsv(csv)) expect(row).toHaveLength(14);
  });

  it('is only a header when nothing was revealed', () => {
    expect(build({ results: [] }).csv).toBe(`﻿${HEADER}\r\n`);
  });
});

describe('buildResultsCsv: rows', () => {
  const sc = scenario();
  const { rows } = sc.build();
  const of = (no: number, q: number) =>
    rows.filter((r) => r.question_no === String(q + 1) && r.player_id === pid(no));

  it('has one row per revealed question and non-kicked player, plus extra rows for multiple entries', () => {
    // single 3 + poll 3 + wordcloud (2 + 1 + 1 unanswered) + open 3 + rating 3
    expect(rows).toHaveLength(3 + 3 + 4 + 3 + 3);
    expect(rows.some((r) => r.nickname === 'Eve')).toBe(false);
  });

  it('orders rows by question, then by final rank', () => {
    expect(rows.map((r) => r.question_no)).toEqual(
      [1, 1, 1, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 6, 6, 6].map(String),
    );
    expect(rows.slice(0, 3).map((r) => r.nickname)).toEqual(['Alice', 'Bob', 'Cara']);
  });

  it('renders each response type as text', () => {
    expect(of(1, Q.single)[0]).toMatchObject({
      question_type: 'single',
      question: 'Capital of France?',
      response: 'Paris',
      answered: 'yes',
    });
    expect(of(2, Q.single)[0]?.response).toBe('Rome');
    expect(of(1, Q.poll)[0]?.response).toBe('Blue');
    expect(of(2, Q.rating)[0]?.response).toBe('4');
    expect(of(1, Q.wordcloud).map((r) => r.response)).toEqual(['sunshine', 'rain']);
  });

  it('marks unanswered players with answered=no and blank answer columns', () => {
    expect(of(3, Q.single)[0]).toMatchObject({
      answered: 'no',
      response: '',
      correct: 'no',
      points: '0',
      streak_bonus: '0',
      response_time_ms: '',
      moderation: '',
    });
    expect(of(3, Q.wordcloud)).toHaveLength(1);
    expect(of(3, Q.wordcloud)[0]).toMatchObject({ answered: 'no', response: '', moderation: '' });
  });

  it('fills correctness, points and response time for scored questions', () => {
    expect(of(1, Q.single)[0]).toMatchObject({
      correct: 'yes',
      points: '1000',
      streak_bonus: '0',
      response_time_ms: '0',
    });
    expect(of(2, Q.single)[0]).toMatchObject({
      correct: 'no',
      points: '0',
      response_time_ms: '1234',
    });
    // The poll is untimed, so there is no response time.
    expect(of(1, Q.poll)[0]).toMatchObject({ correct: '', points: '0', response_time_ms: '' });
  });

  it('shows the moderation status of word-cloud and open-ended entries', () => {
    expect(of(2, Q.wordcloud)[0]).toMatchObject({ response: 'fuck', moderation: 'hidden' });
    expect(of(1, Q.wordcloud)[0]).toMatchObject({ moderation: 'visible' });
    expect(of(1, Q.open)[0]?.moderation).toBe('pending');
  });

  it('repeats final score and rank on every row', () => {
    for (const r of of(1, Q.single).concat(of(1, Q.wordcloud))) {
      expect(r).toMatchObject({ final_score: '1000', final_rank: '1' });
    }
    expect(of(2, Q.rating)[0]).toMatchObject({ final_score: '0', final_rank: '2' });
    expect(of(3, Q.rating)[0]).toMatchObject({ final_score: '0', final_rank: '2' });
  });

  it('includes the streak bonus column from the stored outcome', () => {
    const t = newSession(undefined, { streakBonus: true });
    const two = scenario({ session: t });
    const out = two.build();
    expect(out.rows.every((r) => r.streak_bonus === '0')).toBe(true);
  });
});

describe('buildResultsCsv: which questions appear', () => {
  it('omits skipped questions and questions that were never revealed', () => {
    const sc = scenario({ skipped: [Q.poll] });
    const { rows } = sc.build();
    expect(new Set(rows.map((r) => r.question_no))).toEqual(new Set(['1', '4', '5', '6']));
    const noWordcloud = sc.build({
      results: sc.results.filter((r) => r.questionIndex !== Q.wordcloud),
    });
    expect(new Set(noWordcloud.rows.map((r) => r.question_no))).toEqual(new Set(['1', '5', '6']));
  });

  it('sorts results by question index whatever order they arrive in', () => {
    const sc = scenario();
    const shuffled = [...sc.results].reverse();
    expect(sc.build({ results: shuffled }).csv).toBe(sc.build().csv);
  });

  it('tolerates a result with no responses recorded', () => {
    const sc = scenario();
    const { rows } = sc.build({ responsesByQuestion: [] });
    expect(rows.every((r) => r.answered === 'no')).toBe(true);
    expect(rows).toHaveLength(3 * 5);
  });

  it('skips a result whose question is not in the snapshot', () => {
    const sc = scenario();
    const bogus = { ...(sc.results[0] as StoredQuestionResult), questionIndex: 99 };
    expect(sc.build({ results: [...sc.results, bogus] }).csv).toBe(sc.build().csv);
  });
});

describe('buildResultsCsv: scores and ranks', () => {
  it('leaves final_rank blank when the quiz has no scored questions', () => {
    const t = newSession([questions()[Q.poll]!, questions()[Q.rating]!]);
    const players = [player(1, { nickname: 'Alice' })];
    const responses = [accept(t, openAtIndex(t, 0), pid(1), choice('opt-red'), NOW + 4000)];
    const out = computeReveal({
      meta: revealingAt(t, 0),
      snapshot: t.snapshot,
      responses,
      players,
      scoreboard: null,
      now: NOW,
    });
    const csv = buildResultsCsv({
      meta: t.meta,
      snapshot: t.snapshot,
      players,
      scoreboard: null,
      results: [out.stored],
      responsesByQuestion: [responses],
    });
    const [, row] = parseCsv(csv);
    expect(row?.slice(-2)).toEqual(['0', '']);
  });

  it('leaves final_rank blank until a scoring question was revealed', () => {
    // The quiz has scored questions, but both were skipped: everyone is still tied on zero.
    const { rows } = scenario({ skipped: [Q.single, Q.truefalse] }).build();
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r) => r.final_rank === '')).toBe(true);
  });

  it('breaks ties by nickname, so rows are stable', () => {
    const sc = scenario({ nicknames: ['Zoe', 'Yan', 'Xia', 'Eve'] });
    const firstQuestion = sc.build().rows.filter((r) => r.question_no === '1');
    expect(firstQuestion.map((r) => [r.nickname, r.final_rank])).toEqual([
      ['Zoe', '1'],
      ['Xia', '2'],
      ['Yan', '2'],
    ]);
  });

  it('reads final scores from the scoreboard only', () => {
    const sc = scenario();
    const rows = sc.build({ scoreboard: null }).rows;
    expect(rows.every((r) => r.final_score === '0')).toBe(true);
  });
});

describe('buildResultsCsv: escaping', () => {
  it('quotes fields with commas, quotes and line breaks and doubles embedded quotes', () => {
    const sc = scenario({ nicknames: ['Ann, "the" Great', 'Bob', 'Cara', 'Eve'] });
    const { csv, rows } = sc.build();
    expect(csv).toContain('"Ann, ""the"" Great"');
    const open = rows.find((r) => r.question_type === 'open' && r.nickname.startsWith('Ann'));
    expect(open?.nickname).toBe('Ann, "the" Great');
    expect(open?.response).toBe('Line one,\nline "two"');
  });

  it('quotes a lone carriage return and keeps it inside the field', () => {
    const t = newSession();
    const sc = scenario({ session: t });
    const custom = {
      ...t,
      snapshot: {
        ...t.snapshot,
        questions: t.snapshot.questions.map((q, i) =>
          i === Q.single ? { ...q, prompt: 'a\rb' } : q,
        ),
      },
    };
    const csv = sc.build({ snapshot: custom.snapshot }).csv;
    expect(csv).toContain('"a\rb"');
  });

  it('does not quote plain fields', () => {
    const { csv } = scenario().build();
    expect(csv).toContain(
      '1,single,Capital of France?,Alice,player-01,yes,Paris,yes,1000,0,0,,1000,1',
    );
  });
});

describe('buildResultsCsv: formula injection', () => {
  const dangerous = ['=SUM(A1)', '+1+1', '-2+3', '@cmd', '\tcmd', '\rcmd'];

  it.each(dangerous)('prefixes an apostrophe to a cell starting with %j', (value) => {
    const sc = scenario({ nicknames: ['Alice', 'Bob', 'Cara', 'Eve'] });
    const t = sc.s;
    const questionsWith = t.snapshot.questions.map((q, i) =>
      i === Q.single ? { ...q, prompt: value } : q,
    );
    const { rows } = sc.build({ snapshot: { ...t.snapshot, questions: questionsWith } });
    expect(rows.find((r) => r.question_no === '1')?.question).toBe(`'${value}`);
  });

  it('protects nicknames and player answers too', () => {
    const sc = scenario({ nicknames: ['=Alice', '-Bob', '@Cara', 'Eve'] });
    const { rows } = sc.build();
    expect(rows.filter((r) => r.question_no === '1').map((r) => r.nickname)).toEqual([
      "'=Alice",
      "'-Bob",
      "'@Cara",
    ]);
    expect(rows.find((r) => r.question_type === 'open' && r.player_id === pid(2))?.response).toBe(
      "'=1+1",
    );
  });

  it('leaves numbers and mid-cell operators alone', () => {
    const sc = scenario({ openText: 'a=b and 1-2' });
    const { rows } = sc.build();
    expect(rows.find((r) => r.question_type === 'open' && r.player_id === pid(1))?.response).toBe(
      'a=b and 1-2',
    );
    expect(rows.every((r) => !/^'/.test(r.points) && !/^'/.test(r.final_score))).toBe(true);
  });
});
