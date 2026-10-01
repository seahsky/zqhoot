import type {
  AnswerPayload,
  AnswerRejectReason,
  ModerationStatus,
  Question,
} from '@zqhoot/protocol';
import type { EngineConfig } from './config.ts';
import type { QuizSnapshot, ResponseRecord, SessionMeta } from './model.ts';
import { pointsMultiplier, questionLimitMs } from './questions.ts';
import { basePoints } from './scoring.ts';
import { containsProfanity, normalizeOpenText, normalizeWord } from './text.ts';
import { clamp } from './util.ts';

export type AnswerDecision =
  | { kind: 'accept'; response: ResponseRecord }
  | { kind: 'duplicate'; existing: ResponseRecord }
  | { kind: 'reject'; reason: AnswerRejectReason };

/** Answers this early are still accepted: API Gateway and the Lambda read different clocks (ADR-0005). */
const EARLY_TOLERANCE_MS = 250;

const reject = (reason: AnswerRejectReason): AnswerDecision => ({ kind: 'reject', reason });

function allowedEntries(q: Question): number {
  return q.type === 'wordcloud' || q.type === 'open' ? q.maxEntries : 1;
}

/** Outcome of matching a payload to its question; `normalizedText` is set for text types. */
type Checked = { ok: true; normalizedText?: string } | { ok: false };

function checkPayload(q: Question, payload: AnswerPayload): Checked {
  switch (q.type) {
    case 'single':
    case 'poll':
      return {
        ok: payload.kind === 'choice' && q.options.some((o) => o.id === payload.optionId),
      };
    case 'truefalse':
      return { ok: payload.kind === 'boolean' };
    case 'rating':
      return {
        ok:
          payload.kind === 'rating' &&
          Number.isInteger(payload.value) &&
          payload.value >= 1 &&
          payload.value <= q.max,
      };
    case 'wordcloud':
    case 'open': {
      if (payload.kind !== 'text') return { ok: false };
      const text =
        q.type === 'wordcloud' ? normalizeWord(payload.text) : normalizeOpenText(payload.text);
      return text === null ? { ok: false } : { ok: true, normalizedText: text };
    }
  }
}

/** Two payloads are the same answer if this key matches; text compares by normalised form. */
function identity(payload: AnswerPayload, normalizedText: string | undefined): string {
  switch (payload.kind) {
    case 'choice':
      return `choice:${payload.optionId}`;
    case 'boolean':
      return `boolean:${payload.value}`;
    case 'rating':
      return `rating:${payload.value}`;
    case 'text':
      return `text:${normalizedText ?? payload.text}`;
  }
}

function statusFor(q: Question, text: string | undefined): ModerationStatus {
  const textual = q.type === 'open' || q.type === 'wordcloud';
  if (textual && text !== undefined && containsProfanity(text)) return 'hidden';
  return q.type === 'open' && q.requireApproval ? 'pending' : 'visible';
}

export function evaluateAnswer(i: {
  meta: SessionMeta;
  snapshot: QuizSnapshot;
  playerId: string;
  questionIndex: number;
  payload: AnswerPayload;
  receivedAt: number;
  /** This player's stored responses for this question. */
  existing: ResponseRecord[];
  cfg: EngineConfig;
}): AnswerDecision {
  const { meta, payload, receivedAt, existing } = i;

  if (meta.questionIndex !== i.questionIndex) return reject('not-open');
  if (meta.phase === 'revealing' || meta.phase === 'reveal' || meta.phase === 'leaderboard') {
    return reject('too-late');
  }
  const q = i.snapshot.questions[i.questionIndex];
  if (meta.phase !== 'question' || q === undefined || meta.openAt === null)
    return reject('not-open');

  if (receivedAt < meta.openAt - EARLY_TOLERANCE_MS) return reject('too-early');
  if (meta.deadline !== null && receivedAt > meta.deadline + i.cfg.answerGraceMs) {
    return reject('too-late');
  }

  const checked = checkPayload(q, payload);
  if (!checked.ok) return reject('invalid');

  const wanted = identity(payload, checked.normalizedText);
  const duplicate = existing.find((r) => identity(r.payload, r.normalizedText) === wanted);
  if (duplicate !== undefined) return { kind: 'duplicate', existing: duplicate };
  if (existing.length >= allowedEntries(q)) return reject('limit');

  const limitMs = questionLimitMs(q);
  const elapsedMs = limitMs === null ? null : clamp(receivedAt - meta.openAt, 0, limitMs);
  const multiplier = pointsMultiplier(q);
  let correct: boolean | null = null;
  if (q.type === 'single')
    correct = payload.kind === 'choice' && payload.optionId === q.correctOptionId;
  else if (q.type === 'truefalse')
    correct = payload.kind === 'boolean' && payload.value === q.correct;
  const slot = existing.length;
  const response: ResponseRecord = {
    sessionId: meta.sessionId,
    questionIndex: i.questionIndex,
    playerId: i.playerId,
    slot,
    responseId: `${i.playerId}-${slot}`,
    payload,
    receivedAt,
    elapsedMs,
    correct,
    points: correct === null ? 0 : basePoints({ correct, elapsedMs, limitMs, multiplier }),
    status: statusFor(q, checked.normalizedText),
  };
  if (checked.normalizedText !== undefined) response.normalizedText = checked.normalizedText;
  return { kind: 'accept', response };
}
