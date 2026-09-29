import type { PlayerOutcome, Question } from '@zqhoot/protocol';
import { isScoredType } from '@zqhoot/protocol';
import { responseText, revealedScoredCount } from './aggregate.ts';
import type {
  PlayerRecord,
  QuizSnapshot,
  ResponseRecord,
  Scoreboard,
  SessionMeta,
  StoredQuestionResult,
} from './model.ts';
import { EMPTY_SCORE, rankEntries } from './scoring.ts';

const COLUMNS = [
  'question_no',
  'question_type',
  'question',
  'nickname',
  'player_id',
  'answered',
  'response',
  'correct',
  'points',
  'streak_bonus',
  'response_time_ms',
  'moderation',
  'final_score',
  'final_rank',
] as const;

/** A leading =, +, -, @, tab or CR makes spreadsheet apps evaluate the cell as a formula. */
const FORMULA_TRIGGER = /^[=+\-@\t\r]/;

function cell(value: string | number | null): string {
  if (value === null) return '';
  let text = String(value);
  if (FORMULA_TRIGGER.test(text)) text = `'${text}`;
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

function renderResponse(q: Question, r: ResponseRecord): string {
  const p = r.payload;
  switch (p.kind) {
    case 'choice':
      return (
        (q.type === 'single' || q.type === 'poll'
          ? q.options.find((o) => o.id === p.optionId)?.text
          : undefined) ?? p.optionId
      );
    case 'boolean':
      return p.value ? 'True' : 'False';
    case 'rating':
      return String(p.value);
    case 'text':
      return responseText(r);
  }
}

const yesNo = (v: boolean) => (v ? 'yes' : 'no');

/**
 * RFC 4180 (CRLF after every record) with a UTF-8 BOM so spreadsheet apps pick the encoding.
 * One block of rows per revealed question in question order, players in final rank order.
 */
export function buildResultsCsv(i: {
  meta: SessionMeta;
  snapshot: QuizSnapshot;
  players: PlayerRecord[];
  scoreboard: Scoreboard | null;
  results: StoredQuestionResult[];
  responsesByQuestion: ResponseRecord[][];
}): string {
  const ranked = rankEntries(
    i.players
      .filter((p) => !p.kicked)
      .map((p) => ({
        playerId: p.playerId,
        nickname: p.nickname,
        score: (i.scoreboard?.players[p.playerId] ?? EMPTY_SCORE).score,
      })),
  );
  const hasRanks = revealedScoredCount(i.meta, i.snapshot, i.scoreboard) > 0;
  const rows: string[] = [COLUMNS.join(',')];
  const revealed = [...i.results]
    .filter((r) => !i.meta.skipped.includes(r.questionIndex))
    .sort((a, b) => a.questionIndex - b.questionIndex);

  for (const stored of revealed) {
    const q = i.snapshot.questions[stored.questionIndex];
    if (q === undefined) continue;
    const byPlayer = new Map<string, ResponseRecord[]>();
    for (const r of i.responsesByQuestion[stored.questionIndex] ?? []) {
      const list = byPlayer.get(r.playerId);
      if (list === undefined) byPlayer.set(r.playerId, [r]);
      else list.push(r);
    }
    const textual = q.type === 'wordcloud' || q.type === 'open';

    for (const player of ranked) {
      const mine = (byPlayer.get(player.playerId) ?? []).sort((a, b) => a.slot - b.slot);
      const outcome: PlayerOutcome | undefined = stored.outcomes[player.playerId];
      const perResponse = mine.length > 0 ? mine : [undefined];
      for (const r of perResponse) {
        const scored = isScoredType(q.type);
        rows.push(
          [
            stored.questionIndex + 1,
            q.type,
            q.prompt,
            player.nickname,
            player.playerId,
            yesNo(mine.length > 0),
            r === undefined ? null : renderResponse(q, r),
            scored ? yesNo(r?.correct === true) : null,
            r === undefined || textual ? 0 : (outcome?.points ?? r.points),
            outcome?.streakBonus ?? 0,
            r?.elapsedMs ?? null,
            textual && r !== undefined ? r.status : null,
            player.score,
            hasRanks ? player.rank : null,
          ]
            .map(cell)
            .join(','),
        );
      }
    }
  }
  return `\uFEFF${rows.join('\r\n')}\r\n`;
}
