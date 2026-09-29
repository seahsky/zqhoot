import { describe, expect, it } from 'vitest';
import { LIMITS, Question, QuizInput, TIME_LIMITS_SEC } from '@zqhoot/protocol';
import type { Quiz } from '@zqhoot/protocol';
import {
  TIME_LIMIT_CHOICES,
  addOption,
  addQuestion,
  canAddOption,
  canRemoveOption,
  changeQuestionType,
  defaultTimeLimit,
  deleteQuestion,
  draftAfterSave,
  describeIssue,
  draftFromQuiz,
  duplicateQuestion,
  fieldId,
  isDirty,
  issuesByField,
  moveQuestion,
  newDraft,
  newId,
  newQuestion,
  removeOption,
  removeQuestionImage,
  replaceQuestion,
  setImageAlt,
  setQuestionImage,
  timeLimitLabel,
  validateDraft,
} from '../src/state/editor.ts';
import type { QuizDraft } from '../src/state/editor.ts';

/** A counter, so ids are readable and predictable in these tests. */
const counter = () => {
  let n = 0;
  return () => `id-${String(++n).padStart(6, '0')}`;
};

const types = ['single', 'truefalse', 'poll', 'wordcloud', 'open', 'rating'] as const;

/** A draft that passes validation, with `n` questions of the given types. */
function filled(kinds: readonly (typeof types)[number][], id = counter()): QuizDraft {
  const questions = kinds.map((type, i) => {
    const q = newQuestion(type, id);
    q.prompt = `Question ${i + 1}`;
    if ('options' in q) q.options.forEach((o, j) => (o.text = `Option ${j + 1}`));
    return q;
  });
  return { title: 'A quiz', settings: newDraft(id).settings, questions };
}

describe('ids', () => {
  it('are 21 characters from the URL-safe alphabet, and match the protocol Id', () => {
    const id = newId();
    expect(id).toMatch(/^[A-Za-z0-9_-]{21}$/);
    expect(
      QuizInput.shape.questions.element.safeParse({
        id,
        type: 'rating',
        prompt: 'x',
        timeLimitSec: null,
        max: 5,
      }).success,
    ).toBe(true);
  });

  it('come from the random source given, one symbol per byte', () => {
    const bytes = (a: ArrayBufferView) => {
      const u = a as Uint8Array;
      u.forEach((_, i) => (u[i] = i));
      return a as never;
    };
    expect(newId(bytes)).toBe('0123456789ABCDEFGHIJK');
  });

  it('do not repeat', () => {
    expect(new Set(Array.from({ length: 500 }, () => newId())).size).toBe(500);
  });
});

describe('defaults per type', () => {
  it('scored types get 20 s and standard points; word cloud and open-ended 30 s', () => {
    expect(defaultTimeLimit('single')).toBe(20);
    expect(defaultTimeLimit('truefalse')).toBe(20);
    expect(defaultTimeLimit('wordcloud')).toBe(30);
    expect(defaultTimeLimit('open')).toBe(30);
    const id = counter();
    expect(newQuestion('single', id)).toMatchObject({ timeLimitSec: 20, points: 1 });
    expect(newQuestion('truefalse', id)).toMatchObject({
      timeLimitSec: 20,
      points: 1,
      correct: true,
    });
    expect(newQuestion('wordcloud', id)).toMatchObject({ timeLimitSec: 30, maxEntries: 3 });
    expect(newQuestion('open', id)).toMatchObject({
      timeLimitSec: 30,
      maxEntries: 1,
      requireApproval: true,
    });
    expect(newQuestion('rating', id)).toMatchObject({ max: 5 });
  });

  it('a new multiple-choice question has four options and its first is correct', () => {
    const q = newQuestion('single', counter());
    if (q.type !== 'single') throw new Error();
    expect(q.options).toHaveLength(4);
    expect(q.correctOptionId).toBe(q.options[0]?.id);
    expect(new Set(q.options.map((o) => o.id)).size).toBe(4);
  });

  it('every default time limit is one the protocol accepts', () => {
    for (const type of types) {
      expect(TIME_LIMITS_SEC as readonly number[]).toContain(defaultTimeLimit(type));
    }
  });

  it('a new draft has one question and the protocol default settings', () => {
    const d = newDraft(counter());
    expect(d.questions).toHaveLength(1);
    expect(d.settings).toEqual({ streakBonus: false, showQuestionOnDevices: true, readSeconds: 3 });
    expect(d.title).toBe('');
  });

  it('time limits offer the protocol list and "No limit"', () => {
    expect(TIME_LIMIT_CHOICES).toEqual([...TIME_LIMITS_SEC, null]);
    expect(timeLimitLabel(null)).toBe('No limit');
    expect(timeLimitLabel(20)).toBe('20 seconds');
    expect(timeLimitLabel(60)).toBe('1 minute');
    expect(timeLimitLabel(90)).toBe('90 seconds');
    expect(timeLimitLabel(120)).toBe('2 minutes');
  });
});

describe('the question list', () => {
  const ids = () => filled(['single', 'poll', 'rating']).questions.map((q) => q.prompt);

  it('adds to the end and reports where', () => {
    const { draft, index } = addQuestion(filled(['single']), 'poll', counter());
    expect(index).toBe(1);
    expect(draft.questions.map((q) => q.type)).toEqual(['single', 'poll']);
  });

  it('refuses a 101st question', () => {
    const d = filled(Array.from({ length: LIMITS.questionsMax }, () => 'rating' as const));
    const r = addQuestion(d, 'poll');
    expect(r.index).toBe(-1);
    expect(r.draft).toBe(d);
  });

  it('moves up and down, and stops at the ends', () => {
    const d = filled(['single', 'poll', 'rating']);
    expect(moveQuestion(d, 1, -1).questions.map((q) => q.prompt)).toEqual([
      'Question 2',
      'Question 1',
      'Question 3',
    ]);
    expect(moveQuestion(d, 1, 1).questions.map((q) => q.prompt)).toEqual([
      'Question 1',
      'Question 3',
      'Question 2',
    ]);
    expect(moveQuestion(d, 0, -1)).toBe(d);
    expect(moveQuestion(d, 2, 1)).toBe(d);
    expect(moveQuestion(d, 7, 1)).toBe(d);
    expect(ids()).toHaveLength(3);
  });

  it('deletes by index', () => {
    const d = filled(['single', 'poll', 'rating']);
    expect(deleteQuestion(d, 1).questions.map((q) => q.prompt)).toEqual([
      'Question 1',
      'Question 3',
    ]);
    expect(deleteQuestion(d, 9)).toBe(d);
  });

  it('duplicates right after the original with fresh ids, and remaps the correct option', () => {
    const id = counter();
    const d = filled(['single', 'rating'], id);
    const { draft, index } = duplicateQuestion(d, 0, id);
    expect(index).toBe(1);
    const [a, b] = draft.questions;
    if (a?.type !== 'single' || b?.type !== 'single') throw new Error();
    expect(b.prompt).toBe(a.prompt);
    expect(b.id).not.toBe(a.id);
    const all = [...a.options, ...b.options].map((o) => o.id);
    expect(new Set(all).size).toBe(8);
    // The copy's correct answer is the copy's own option in the same position.
    expect(b.options.findIndex((o) => o.id === b.correctOptionId)).toBe(
      a.options.findIndex((o) => o.id === a.correctOptionId),
    );
    expect(draft.questions).toHaveLength(3);
    expect(draft.questions[2]?.type).toBe('rating');
    expect(validateDraft(draft).ok).toBe(true);
  });

  it('a duplicate is independent of its original', () => {
    const d = filled(['open']);
    const { draft } = duplicateQuestion(d, 0);
    const [a, b] = draft.questions;
    if (b) b.prompt = 'changed';
    expect(a?.prompt).toBe('Question 1');
  });

  it('replaces one question and leaves the rest', () => {
    const d = filled(['single', 'poll']);
    const next = replaceQuestion(d, 1, { ...d.questions[1]!, prompt: 'New' });
    expect(next.questions.map((q) => q.prompt)).toEqual(['Question 1', 'New']);
    expect(replaceQuestion(d, 5, d.questions[0]!)).toBe(d);
  });
});

describe('editing one question', () => {
  it('changing the type keeps the prompt, image and time limit, and the option texts', () => {
    const id = counter();
    const q = newQuestion('single', id);
    if (q.type !== 'single') throw new Error();
    q.prompt = 'Pick one';
    q.imageKey = 'media/host/abcdef.png';
    q.timeLimitSec = 45;
    q.options.forEach((o, i) => (o.text = `T${i}`));
    const poll = changeQuestionType(q, 'poll', id);
    expect(poll).toMatchObject({
      type: 'poll',
      id: q.id,
      prompt: 'Pick one',
      imageKey: 'media/host/abcdef.png',
      timeLimitSec: 45,
    });
    if (poll.type !== 'poll') throw new Error();
    expect(poll.options.map((o) => o.text)).toEqual(['T0', 'T1', 'T2', 'T3']);
    const back = changeQuestionType(poll, 'single', id);
    if (back.type !== 'single') throw new Error();
    expect(back.correctOptionId).toBe(back.options[0]?.id);
    const cloud = changeQuestionType(poll, 'wordcloud', id);
    expect(cloud).toMatchObject({ type: 'wordcloud', prompt: 'Pick one', maxEntries: 3 });
    expect(changeQuestionType(q, 'single')).toBe(q);
  });

  it('turning a six-option poll into multiple choice keeps four options', () => {
    const id = counter();
    let poll = newQuestion('poll', id);
    poll = addOption(addOption(poll, id), id);
    if (poll.type !== 'poll') throw new Error();
    expect(poll.options).toHaveLength(6);
    const single = changeQuestionType(poll, 'single', id);
    if (single.type !== 'single') throw new Error();
    expect(single.options).toHaveLength(LIMITS.choiceOptionsMax);
  });

  it('adds options up to 4 (multiple choice) or 6 (poll), and removes down to 2', () => {
    const id = counter();
    let single = newQuestion('single', id);
    expect(canAddOption(single)).toBe(false);
    expect(addOption(single, id)).toBe(single);
    single = removeOption(single, 3);
    expect(canAddOption(single)).toBe(true);
    single = addOption(single, id);
    if (single.type !== 'single') throw new Error();
    expect(single.options).toHaveLength(4);

    let poll = newQuestion('poll', id);
    poll = addOption(addOption(poll, id), id);
    expect(canAddOption(poll)).toBe(false);
    for (let i = 0; i < 4; i++) poll = removeOption(poll, 0);
    if (poll.type !== 'poll') throw new Error();
    expect(poll.options).toHaveLength(2);
    expect(canRemoveOption(poll)).toBe(false);
    expect(removeOption(poll, 0)).toBe(poll);
    expect(canRemoveOption(newQuestion('rating', id))).toBe(false);
  });

  it('removing the correct option hands the mark to the first one left', () => {
    const q = newQuestion('single', counter());
    if (q.type !== 'single') throw new Error();
    const next = removeOption(q, 0);
    if (next.type !== 'single') throw new Error();
    expect(next.options).toHaveLength(3);
    expect(next.correctOptionId).toBe(next.options[0]?.id);
    const other = removeOption(q, 2);
    if (other.type !== 'single') throw new Error();
    expect(other.correctOptionId).toBe(q.correctOptionId);
  });
});

describe('dirty tracking', () => {
  it('compares the whole draft', () => {
    const saved = filled(['single']);
    expect(isDirty(draftFromQuiz(saved as unknown as Quiz), saved)).toBe(false);
    const edited = { ...saved, title: 'Different' };
    expect(isDirty(edited, saved)).toBe(true);
  });

  it('draftFromQuiz copies deeply and drops the server fields', () => {
    const d = filled(['single']);
    const quiz = {
      ...d,
      id: 'quiz-aaaaaa',
      ownerId: 'o',
      version: 3,
      createdAt: 1,
      updatedAt: 2,
    } as Quiz;
    const copy = draftFromQuiz(quiz);
    expect(Object.keys(copy).sort()).toEqual(['questions', 'settings', 'title']);
    (copy.questions[0] as { prompt: string }).prompt = 'x';
    expect(quiz.questions[0]?.prompt).toBe('Question 1');
  });
});

describe('saving while the host keeps typing', () => {
  it('shows the server copy when nothing changed during the save', () => {
    const sent = filled(['single']);
    const server = { ...draftFromQuiz(sent as unknown as Quiz), title: 'A quiz (server)' };
    expect(draftAfterSave(sent, sent, server)).toBe(server);
    // An equal copy counts as unchanged, so a re-render cannot keep a stale one.
    expect(draftAfterSave(draftFromQuiz(sent as unknown as Quiz), sent, server)).toBe(server);
  });

  it('keeps what was typed while the request was in flight, and it stays unsaved', () => {
    const sent = filled(['single', 'poll']);
    const server = draftFromQuiz(sent as unknown as Quiz);
    const typed = { ...sent, title: 'A better title' };
    const shown = draftAfterSave(typed, sent, server);
    expect(shown).toBe(typed);
    expect(isDirty(shown, server)).toBe(true);
  });
});

describe('attaching an uploaded picture', () => {
  it('goes to the question with that id', () => {
    const d = filled(['single', 'poll', 'rating']);
    const target = d.questions[1]?.id as string;
    const next = setQuestionImage(d, target, 'media/host-abc/abcdef123456.png');
    expect(next.questions.map((q) => q.imageKey)).toEqual([
      undefined,
      'media/host-abc/abcdef123456.png',
      undefined,
    ]);
    expect(d.questions[1]?.imageKey).toBeUndefined();
  });

  it('follows the question when it moved while the upload ran', () => {
    const d = filled(['single', 'poll', 'rating']);
    const target = d.questions[0]?.id as string;
    const moved = moveQuestion(moveQuestion(d, 0, 1), 1, 1);
    const next = setQuestionImage(moved, target, 'media/host-abc/abcdef123456.png');
    expect(next.questions.map((q) => [q.prompt, q.imageKey])).toEqual([
      ['Question 2', undefined],
      ['Question 3', undefined],
      ['Question 1', 'media/host-abc/abcdef123456.png'],
    ]);
  });

  it('does nothing when the question was deleted meanwhile', () => {
    const d = filled(['single', 'poll']);
    const target = d.questions[0]?.id as string;
    const after = deleteQuestion(d, 0);
    expect(setQuestionImage(after, target, 'media/host-abc/abcdef123456.png')).toBe(after);
  });

  it('keeps the type-specific fields of the question', () => {
    const d = filled(['single']);
    const next = setQuestionImage(
      d,
      d.questions[0]?.id as string,
      'media/host-abc/abcdef123456.png',
    );
    const q = next.questions[0];
    expect(q?.type === 'single' && q.options.length).toBe(4);
    expect(Question.safeParse(q).success).toBe(true);
  });
});

describe('the picture and its description', () => {
  const KEY = 'media/host-abc/abcdef123456.png';
  const withPicture = (kinds: readonly (typeof types)[number][] = ['single']) => {
    const d = filled(kinds);
    return setQuestionImage(d, d.questions[0]?.id as string, KEY);
  };

  it('a description is set and cleared as a question field; empty means none', () => {
    const q = withPicture().questions[0] as Question;
    const described = setImageAlt(q, 'A grey, cratered planet');
    expect(described.imageAlt).toBe('A grey, cratered planet');
    expect(q.imageAlt).toBeUndefined();
    const cleared = setImageAlt(described, '');
    expect('imageAlt' in cleared).toBe(false);
    expect(cleared.imageKey).toBe(KEY);
  });

  it('removing the picture removes its description, so the draft stays valid', () => {
    const d = withPicture(['poll']);
    const described = replaceQuestion(d, 0, setImageAlt(d.questions[0] as Question, 'Two forks'));
    expect(validateDraft(described).ok).toBe(true);
    const removed = removeQuestionImage(described.questions[0] as Question);
    expect('imageKey' in removed).toBe(false);
    expect('imageAlt' in removed).toBe(false);
    expect(validateDraft(replaceQuestion(described, 0, removed)).ok).toBe(true);
  });

  it('changing the type keeps the description with the picture', () => {
    const q = setImageAlt(withPicture().questions[0] as Question, 'A rocky planet');
    const poll = changeQuestionType(q, 'poll', counter());
    expect(poll).toMatchObject({ type: 'poll', imageKey: KEY, imageAlt: 'A rocky planet' });
    expect(Question.safeParse(poll).success).toBe(true);
  });

  it('a replacement picture keeps the description the host wrote', () => {
    const d = withPicture();
    const described = replaceQuestion(d, 0, setImageAlt(d.questions[0] as Question, 'Rings'));
    const next = setQuestionImage(
      described,
      described.questions[0]?.id as string,
      'media/host-abc/other1234567.png',
    );
    expect(next.questions[0]).toMatchObject({
      imageKey: 'media/host-abc/other1234567.png',
      imageAlt: 'Rings',
    });
  });

  it('saves the trimmed description, and drops one that was only spaces', () => {
    const d = withPicture(['single', 'poll']);
    const q0 = setImageAlt(d.questions[0] as Question, '  Rings, edge-on  ');
    const q1 = setQuestionImage(d, d.questions[1]?.id as string, KEY).questions[1] as Question;
    const both = replaceQuestion(replaceQuestion(d, 0, q0), 1, setImageAlt(q1, '   '));
    const r = validateDraft(both);
    if (!r.ok) throw new Error(JSON.stringify(r.issues));
    expect(r.input.questions[0]?.imageAlt).toBe('Rings, edge-on');
    expect('imageAlt' in (r.input.questions[1] as object)).toBe(false);
    expect(QuizInput.safeParse(r.input).success).toBe(true);
  });

  it('says what is wrong with a description that is too long or has no picture', () => {
    const d = withPicture();
    const tooLong = replaceQuestion(
      d,
      0,
      setImageAlt(d.questions[0] as Question, 'x'.repeat(LIMITS.imageAltMax + 1)),
    );
    const long = validateDraft(tooLong);
    if (long.ok) throw new Error();
    expect(long.issues).toContainEqual({
      path: ['questions', 0, 'imageAlt'],
      fieldId: 'f-questions-0-imageAlt',
      message: `Question 1: the image description can be at most ${LIMITS.imageAltMax} characters.`,
      question: 0,
    });

    const orphan = replaceQuestion(filled(['poll']), 0, {
      ...(filled(['poll']).questions[0] as Question),
      imageAlt: 'A picture that is not there',
    });
    const r = validateDraft(orphan);
    if (r.ok) throw new Error();
    expect(r.issues.map((i) => i.message)).toContain(
      'Question 1: the image description needs an image. Add one, or clear the description.',
    );
  });
});

describe('validation', () => {
  it('accepts a good draft and returns the parsed (trimmed) input', () => {
    const d = filled(['single', 'truefalse', 'poll', 'wordcloud', 'open', 'rating']);
    d.title = '  Padded title  ';
    const r = validateDraft(d);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.input.title).toBe('Padded title');
  });

  it('a fresh draft is not valid yet, and says what is missing', () => {
    const r = validateDraft(newDraft(counter()));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    const messages = r.issues.map((i) => i.message);
    expect(messages).toContain('Give the quiz a title.');
    expect(messages).toContain('Question 1: write the question.');
    expect(messages).toContain('Question 1, answer A: write the answer text.');
    expect(messages).toContain('Question 1, answer D: write the answer text.');
  });

  it('maps each issue to the id of the control it belongs to', () => {
    const d = filled(['single', 'poll']);
    d.title = '';
    (d.questions[1] as { prompt: string }).prompt = '';
    const poll = d.questions[1];
    if (poll?.type !== 'poll') throw new Error();
    poll.options[1]!.text = '';
    const r = validateDraft(d);
    if (r.ok) throw new Error('should be invalid');
    const byId = new Map(r.issues.map((i) => [i.fieldId, i]));
    expect(byId.get('f-title')?.question).toBeNull();
    expect(byId.get('f-questions-1-prompt')?.question).toBe(1);
    expect(byId.get('f-questions-1-options-1-text')?.message).toBe(
      'Question 2, answer B: write the answer text.',
    );
    expect(r.issues.every((i) => i.fieldId === fieldId(i.path))).toBe(true);
  });

  it("describes limits in the host's terms", () => {
    const d = filled(['rating', 'wordcloud']);
    d.title = 'x'.repeat(LIMITS.quizTitleMax + 1);
    (d.questions[0] as { prompt: string }).prompt = 'y'.repeat(LIMITS.questionPromptMax + 1);
    (d.questions[0] as { max: number }).max = 2;
    (d.questions[1] as { maxEntries: number }).maxEntries = 9;
    (d.questions[1] as { timeLimitSec: number }).timeLimitSec = 7;
    d.settings.readSeconds = 11;
    const r = validateDraft(d);
    if (r.ok) throw new Error();
    const messages = r.issues.map((i) => i.message);
    expect(messages).toContain(`The title can be at most ${LIMITS.quizTitleMax} characters.`);
    expect(messages).toContain(
      `Question 1: the question can be at most ${LIMITS.questionPromptMax} characters.`,
    );
    expect(messages).toContain(
      `Question 1: choose a scale from ${LIMITS.ratingMaxMin} to ${LIMITS.ratingMaxMax}.`,
    );
    expect(messages).toContain('Question 2: choose how many entries each player can send.');
    expect(messages).toContain('Question 2: choose a time limit from the list.');
    expect(messages).toContain(
      `Read time must be a whole number of seconds from 0 to ${LIMITS.readSecondsMax}.`,
    );
  });

  it('handles the list-level problems: no questions, too many, duplicate ids', () => {
    const empty = validateDraft({ ...filled(['rating']), questions: [] });
    if (empty.ok) throw new Error();
    expect(empty.issues.map((i) => i.message)).toContain('Add at least one question.');
    expect(empty.issues[0]?.fieldId).toBe('f-questions');

    const dupe = filled(['rating', 'rating']);
    (dupe.questions[1] as { id: string }).id = dupe.questions[0]?.id as string;
    const r = validateDraft(dupe);
    if (r.ok) throw new Error();
    expect(r.issues.map((i) => i.message)).toContain(
      'Two questions share an id. Duplicate one of them again.',
    );
  });

  it('points a duplicate option id and a wrong correct answer at their controls', () => {
    const d = filled(['single']);
    const q = d.questions[0];
    if (q?.type !== 'single') throw new Error();
    q.correctOptionId = 'not-an-option';
    const r = validateDraft(d);
    if (r.ok) throw new Error();
    expect(r.issues.map((i) => [i.fieldId, i.message])).toContainEqual([
      'f-questions-0-correctOptionId',
      'Question 1: choose the correct answer.',
    ]);
  });

  it('never repeats the same message for the same field', () => {
    const r = validateDraft({ ...newDraft(counter()), title: '' });
    if (r.ok) throw new Error();
    const keys = r.issues.map((i) => `${i.fieldId}|${i.message}`);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('groups issues by field for the inline messages', () => {
    const r = validateDraft(newDraft(counter()));
    if (r.ok) throw new Error();
    const grouped = issuesByField(r.issues);
    expect(grouped.get('f-title')).toHaveLength(1);
  });

  it('falls back to the schema text for a shape it does not know', () => {
    expect(describeIssue({ code: 'custom', path: ['somewhere', 'else'], message: 'odd' })).toBe(
      'odd',
    );
  });

  it('a valid draft is exactly what the protocol parses, question by question', () => {
    const d = filled(['single', 'truefalse', 'poll', 'wordcloud', 'open', 'rating']);
    for (const q of d.questions) expect(Question.safeParse(q).success, q.type).toBe(true);
  });
});
