import { DEFAULT_QUIZ_SETTINGS, LIMITS, QuizInput, TIME_LIMITS_SEC } from '@zqhoot/protocol';
import type {
  PointsMultiplier,
  Question,
  QuestionType,
  Quiz,
  QuizSettings,
} from '@zqhoot/protocol';
import { SLOTS } from '../ui/slots.ts';

/**
 * The quiz editor's model: a plain `QuizInput`-shaped draft and pure functions over it, so
 * every edit is testable without a browser. The draft may be invalid while it is being typed;
 * `validateDraft` is the one gate (the protocol's own schema, mapped to fields).
 */

export interface QuizDraft {
  title: string;
  settings: QuizSettings;
  questions: Question[];
}

export const QUESTION_TYPES: ReadonlyArray<{ type: QuestionType; label: string; hint: string }> = [
  { type: 'single', label: 'Multiple choice', hint: '2 to 4 answers, one is correct' },
  { type: 'truefalse', label: 'True or false', hint: 'One statement, one correct side' },
  { type: 'poll', label: 'Poll', hint: '2 to 6 options, no right answer' },
  { type: 'wordcloud', label: 'Word cloud', hint: 'Players send words; the most common grow' },
  { type: 'open', label: 'Open-ended', hint: 'Players write a response you can approve' },
  { type: 'rating', label: 'Rating', hint: 'A scale from 1 up to 3 to 10' },
];

export function typeLabel(type: QuestionType): string {
  return QUESTION_TYPES.find((t) => t.type === type)?.label ?? type;
}

// ---------------------------------------------------------------------------
// Ids
// ---------------------------------------------------------------------------

const ID_ALPHABET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz_-';
const ID_LENGTH = 21;

/** nanoid-shaped ids (64 symbols, 21 characters) from WebCrypto, so no dependency is needed. */
export function newId(
  getRandomValues: Crypto['getRandomValues'] = (a) => crypto.getRandomValues(a),
): string {
  const bytes = getRandomValues(new Uint8Array(ID_LENGTH));
  let id = '';
  // 256 is a multiple of 64, so `& 63` is unbiased.
  for (const b of bytes) id += ID_ALPHABET.charAt(b & 63);
  return id;
}

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

export type IdSource = () => string;

const isScored = (t: QuestionType) => t === 'single' || t === 'truefalse';

/** 20 s for scored questions, 30 s for word cloud and open-ended, 20 s for the rest. */
export function defaultTimeLimit(type: QuestionType): number {
  return type === 'wordcloud' || type === 'open' ? 30 : 20;
}

const STANDARD: PointsMultiplier = 1;

export function newQuestion(type: QuestionType, id: IdSource = newId): Question {
  const base = { id: id(), prompt: '', timeLimitSec: defaultTimeLimit(type) };
  const options = (n: number) => Array.from({ length: n }, () => ({ id: id(), text: '' }));
  switch (type) {
    case 'single': {
      const opts = options(4);
      return {
        ...base,
        type,
        options: opts,
        correctOptionId: (opts[0] as { id: string }).id,
        points: STANDARD,
      };
    }
    case 'truefalse':
      return { ...base, type, correct: true, points: STANDARD };
    case 'poll':
      return { ...base, type, options: options(4) };
    case 'wordcloud':
      return { ...base, type, maxEntries: 3 };
    case 'open':
      return { ...base, type, maxEntries: 1, requireApproval: true };
    case 'rating':
      return { ...base, type, max: 5 };
  }
}

export function newDraft(id: IdSource = newId): QuizDraft {
  return {
    title: '',
    settings: { ...DEFAULT_QUIZ_SETTINGS },
    questions: [newQuestion('single', id)],
  };
}

export function draftFromQuiz(quiz: Pick<Quiz, 'title' | 'settings' | 'questions'>): QuizDraft {
  // Plain JSON, so a round trip is a deep copy.
  return JSON.parse(
    JSON.stringify({ title: quiz.title, settings: quiz.settings, questions: quiz.questions }),
  ) as QuizDraft;
}

// ---------------------------------------------------------------------------
// The question list
// ---------------------------------------------------------------------------

export function addQuestion(
  draft: QuizDraft,
  type: QuestionType,
  id: IdSource = newId,
): { draft: QuizDraft; index: number } {
  if (draft.questions.length >= LIMITS.questionsMax) return { draft, index: -1 };
  return {
    draft: { ...draft, questions: [...draft.questions, newQuestion(type, id)] },
    index: draft.questions.length,
  };
}

/** Moves one place up (-1) or down (+1); a move past either end changes nothing. */
export function moveQuestion(draft: QuizDraft, index: number, delta: -1 | 1): QuizDraft {
  const to = index + delta;
  if (index < 0 || index >= draft.questions.length || to < 0 || to >= draft.questions.length) {
    return draft;
  }
  const questions = [...draft.questions];
  const [moved] = questions.splice(index, 1);
  questions.splice(to, 0, moved as Question);
  return { ...draft, questions };
}

export function deleteQuestion(draft: QuizDraft, index: number): QuizDraft {
  if (index < 0 || index >= draft.questions.length) return draft;
  return { ...draft, questions: draft.questions.filter((_, i) => i !== index) };
}

/** A copy right after the original, with fresh ids so the two never collide. */
export function duplicateQuestion(
  draft: QuizDraft,
  index: number,
  id: IdSource = newId,
): { draft: QuizDraft; index: number } {
  const original = draft.questions[index];
  if (!original || draft.questions.length >= LIMITS.questionsMax) return { draft, index: -1 };
  const copy = JSON.parse(JSON.stringify(original)) as Question;
  copy.id = id();
  if (copy.type === 'single') {
    const map = new Map<string, string>();
    copy.options = copy.options.map((o) => {
      const fresh = id();
      map.set(o.id, fresh);
      return { ...o, id: fresh };
    });
    copy.correctOptionId = map.get(copy.correctOptionId) ?? (copy.options[0]?.id as string);
  } else if (copy.type === 'poll') {
    copy.options = copy.options.map((o) => ({ ...o, id: id() }));
  }
  const questions = [...draft.questions];
  questions.splice(index + 1, 0, copy);
  return { draft: { ...draft, questions }, index: index + 1 };
}

export function replaceQuestion(draft: QuizDraft, index: number, question: Question): QuizDraft {
  if (index < 0 || index >= draft.questions.length) return draft;
  const questions = [...draft.questions];
  questions[index] = question;
  return { ...draft, questions };
}

/**
 * Removes the picture. Its description goes with it: `imageAlt` without an `imageKey` is
 * refused by the schema, and a description of nothing has no field to sit in.
 */
export function removeQuestionImage(q: Question): Question {
  const { imageKey: _key, imageAlt: _alt, ...rest } = q;
  return rest as Question;
}

/** The description of the picture; an empty one is no description, so the key goes. */
export function setImageAlt(q: Question, text: string): Question {
  if (text === '') {
    const { imageAlt: _alt, ...rest } = q;
    return rest as Question;
  }
  return { ...q, imageAlt: text } as Question;
}

/**
 * Sets a question's picture by its id. An upload takes seconds, and the host may move, delete
 * or duplicate questions meanwhile, so the position it started at means nothing when it ends.
 * A question that is gone changes nothing.
 */
export function setQuestionImage(draft: QuizDraft, questionId: string, key: string): QuizDraft {
  const index = draft.questions.findIndex((q) => q.id === questionId);
  const q = draft.questions[index];
  return q ? replaceQuestion(draft, index, { ...q, imageKey: key } as Question) : draft;
}

// ---------------------------------------------------------------------------
// One question
// ---------------------------------------------------------------------------

/**
 * Switches the type and keeps what still applies: prompt, image (and its description) and time
 * limit always, and the option texts when both types have options (the first one becomes the
 * correct answer).
 */
export function changeQuestionType(
  q: Question,
  type: QuestionType,
  id: IdSource = newId,
): Question {
  if (q.type === type) return q;
  const fresh = newQuestion(type, id);
  const carried = {
    ...fresh,
    id: q.id,
    prompt: q.prompt,
    timeLimitSec: q.timeLimitSec,
    ...(q.imageKey !== undefined ? { imageKey: q.imageKey } : {}),
    ...(q.imageAlt !== undefined ? { imageAlt: q.imageAlt } : {}),
  } as Question;
  const oldOptions = 'options' in q ? q.options : null;
  if (oldOptions && 'options' in carried) {
    const max = carried.type === 'poll' ? LIMITS.pollOptionsMax : LIMITS.choiceOptionsMax;
    const keep = oldOptions.slice(0, max);
    // A choice question needs two options; top up from the fresh ones.
    const options = [...keep, ...carried.options.slice(keep.length)].slice(
      0,
      Math.max(keep.length, LIMITS.choiceOptionsMin),
    );
    carried.options = options;
    if (carried.type === 'single') carried.correctOptionId = (options[0] as { id: string }).id;
  }
  return carried;
}

export function canAddOption(q: Question): boolean {
  if (q.type === 'single') return q.options.length < LIMITS.choiceOptionsMax;
  if (q.type === 'poll') return q.options.length < LIMITS.pollOptionsMax;
  return false;
}

export function canRemoveOption(q: Question): boolean {
  return (q.type === 'single' || q.type === 'poll') && q.options.length > LIMITS.choiceOptionsMin;
}

export function addOption(q: Question, id: IdSource = newId): Question {
  if (!canAddOption(q) || !('options' in q)) return q;
  return { ...q, options: [...q.options, { id: id(), text: '' }] } as Question;
}

/** Removing the correct answer hands the mark to the first option that is left. */
export function removeOption(q: Question, index: number): Question {
  if (!canRemoveOption(q) || !('options' in q)) return q;
  const options = q.options.filter((_, i) => i !== index);
  if (q.type === 'single') {
    const stillThere = options.some((o) => o.id === q.correctOptionId);
    return {
      ...q,
      options,
      correctOptionId: stillThere ? q.correctOptionId : (options[0] as { id: string }).id,
    };
  }
  return { ...q, options } as Question;
}

/** Points (none, standard, double) only mean something for the two scored types. */
export function hasPointsChoice(q: Question): q is Extract<Question, { points: PointsMultiplier }> {
  return isScored(q.type);
}

/** The time limits a select offers: the protocol's list, and "No limit" (null). */
export const TIME_LIMIT_CHOICES: ReadonlyArray<number | null> = [...TIME_LIMITS_SEC, null];

export function timeLimitLabel(sec: number | null): string {
  if (sec === null) return 'No limit';
  if (sec < 60) return `${sec} seconds`;
  const min = sec / 60;
  return Number.isInteger(min) ? `${min} ${min === 1 ? 'minute' : 'minutes'}` : `${sec} seconds`;
}

export const POINTS_CHOICES: ReadonlyArray<{ value: PointsMultiplier; label: string }> = [
  { value: 0, label: 'No points' },
  { value: 1, label: 'Standard' },
  { value: 2, label: 'Double points' },
];

// ---------------------------------------------------------------------------
// Dirty tracking
// ---------------------------------------------------------------------------

export function isDirty(draft: QuizDraft, saved: QuizDraft): boolean {
  return JSON.stringify(draft) !== JSON.stringify(saved);
}

/**
 * The draft to show once a save has succeeded. The server's copy replaces what was sent, but
 * anything typed while the request was in flight stays: it is not saved, so it must still show
 * as unsaved changes rather than vanish under "All changes saved".
 */
export function draftAfterSave(current: QuizDraft, sent: QuizDraft, server: QuizDraft): QuizDraft {
  return isDirty(current, sent) ? current : server;
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

export type PathPart = string | number;

export interface FieldIssue {
  path: PathPart[];
  /** DOM id of the control the summary links to. */
  fieldId: string;
  /** Plain-language sentence naming the question and the field. */
  message: string;
  /** Zero-based question the issue is about, or null for the quiz itself. */
  question: number | null;
}

export function fieldId(path: readonly PathPart[]): string {
  return `f-${path.join('-')}`;
}

type RawIssue = { code: string; path: PathPart[]; message: string };

function tooSmall(i: RawIssue) {
  return i.code === 'too_small';
}
function tooBig(i: RawIssue) {
  return i.code === 'too_big';
}

function questionLabel(index: number): string {
  return `Question ${index + 1}`;
}

/** Turns one zod issue into a sentence a host can act on. Unknown shapes keep zod's own text. */
export function describeIssue(issue: RawIssue): string {
  const { path } = issue;
  const [head, second, third, fourth, fifth] = path;
  if (head === 'title') {
    return tooBig(issue)
      ? `The title can be at most ${LIMITS.quizTitleMax} characters.`
      : 'Give the quiz a title.';
  }
  if (head === 'settings') {
    return second === 'readSeconds'
      ? `Read time must be a whole number of seconds from 0 to ${LIMITS.readSecondsMax}.`
      : 'A quiz setting is not valid.';
  }
  if (head === 'questions' && second === undefined) {
    if (tooSmall(issue)) return 'Add at least one question.';
    if (tooBig(issue)) return `A quiz can have at most ${LIMITS.questionsMax} questions.`;
    return 'Two questions share an id. Duplicate one of them again.';
  }
  if (head === 'questions' && typeof second === 'number') {
    const q = questionLabel(second);
    switch (third) {
      case undefined:
        return `${q} is not valid.`;
      case 'prompt':
        return tooBig(issue)
          ? `${q}: the question can be at most ${LIMITS.questionPromptMax} characters.`
          : `${q}: write the question.`;
      case 'imageKey':
        return `${q}: the image is not valid. Remove it and add it again.`;
      case 'imageAlt':
        return tooBig(issue)
          ? `${q}: the image description can be at most ${LIMITS.imageAltMax} characters.`
          : `${q}: the image description needs an image. Add one, or clear the description.`;
      case 'timeLimitSec':
        return `${q}: choose a time limit from the list.`;
      case 'points':
        return `${q}: choose how many points it is worth.`;
      case 'correctOptionId':
        return `${q}: choose the correct answer.`;
      case 'correct':
        return `${q}: choose true or false as the correct answer.`;
      case 'maxEntries':
        return `${q}: choose how many entries each player can send.`;
      case 'max':
        return `${q}: choose a scale from ${LIMITS.ratingMaxMin} to ${LIMITS.ratingMaxMax}.`;
      case 'minLabel':
      case 'maxLabel':
        return `${q}: the ${third === 'minLabel' ? 'low' : 'high'} label can be at most ${LIMITS.ratingLabelMax} characters.`;
      case 'options': {
        if (typeof fourth === 'number') {
          const letter = SLOTS[fourth]?.letter ?? String(fourth + 1);
          return fifth === 'text' && tooBig(issue)
            ? `${q}, answer ${letter}: at most ${LIMITS.optionTextMax} characters.`
            : `${q}, answer ${letter}: write the answer text.`;
        }
        if (tooSmall(issue)) return `${q} needs at least ${LIMITS.choiceOptionsMin} answers.`;
        if (tooBig(issue)) return `${q} has too many answers.`;
        return `${q} has two answers with the same id. Remove one and add it again.`;
      }
      default:
        return `${q}: ${issue.message}`;
    }
  }
  return issue.message;
}

/** Where a control for an issue lives: the deepest path that is an actual field. */
function issueTarget(path: readonly PathPart[]): PathPart[] {
  const p = [...path];
  // Option-level problems point at the option's text field; list-level ones at the list.
  if (p[0] === 'questions' && p[2] === 'options' && typeof p[3] === 'number' && p.length === 4) {
    p.push('text');
  }
  return p;
}

/** A description of only spaces is trimmed to nothing by the schema; it is not worth storing. */
function withoutBlankAlt(input: QuizInput): QuizInput {
  if (!input.questions.some((q) => q.imageAlt === '')) return input;
  return {
    ...input,
    questions: input.questions.map((q) => (q.imageAlt === '' ? setImageAlt(q, '') : q)),
  };
}

export type ValidationResult = { ok: true; input: QuizInput } | { ok: false; issues: FieldIssue[] };

export function validateDraft(draft: QuizDraft): ValidationResult {
  const parsed = QuizInput.safeParse(draft);
  if (parsed.success) return { ok: true, input: withoutBlankAlt(parsed.data) };
  const seen = new Set<string>();
  const issues: FieldIssue[] = [];
  for (const raw of parsed.error.issues) {
    const path = raw.path.filter((p): p is PathPart => typeof p !== 'symbol');
    const message = describeIssue({ code: raw.code, path, message: raw.message });
    // A refine on the whole quiz repeats for every question; say it once.
    const key = `${path.join('.')}|${message}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const target = issueTarget(path);
    issues.push({
      path: target,
      fieldId: fieldId(target),
      message,
      question: target[0] === 'questions' && typeof target[1] === 'number' ? target[1] : null,
    });
  }
  return { ok: false, issues };
}

/** Issues grouped by the exact field they belong to, for the inline messages. */
export function issuesByField(issues: readonly FieldIssue[]): Map<string, FieldIssue[]> {
  const byField = new Map<string, FieldIssue[]>();
  for (const issue of issues) {
    const list = byField.get(issue.fieldId) ?? [];
    list.push(issue);
    byField.set(issue.fieldId, list);
  }
  return byField;
}
