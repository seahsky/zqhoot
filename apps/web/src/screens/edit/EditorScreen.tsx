import { useEffect, useRef, useState } from 'react';
import type { QuestionType } from '@zqhoot/protocol';
import { LIMITS } from '@zqhoot/protocol';
import {
  QUESTION_TYPES,
  addQuestion,
  deleteQuestion,
  duplicateQuestion,
  issuesByField,
  moveQuestion,
  replaceQuestion,
} from '../../state/editor.ts';
import type { FieldIssue, QuizDraft } from '../../state/editor.ts';
import { Button } from '../../ui/Button.tsx';
import { CheckboxField, SelectField } from '../../ui/Controls.tsx';
import { ConfirmDialog } from '../../ui/ConfirmDialog.tsx';
import { rescueFocus } from '../../ui/focus.ts';
import { HostShell } from '../../ui/HostShell.tsx';
import { StatusLine } from '../../ui/StatusLine.tsx';
import { TextField } from '../../ui/TextField.tsx';
import { QuestionCard } from './QuestionCard.tsx';
import styles from './Editor.module.css';

export type SaveStatus = 'idle' | 'saving' | 'saved' | 'error';

export interface EditorScreenProps {
  isNew: boolean;
  draft: QuizDraft;
  onChange: (draft: QuizDraft) => void;
  /** Problems from the last save attempt, kept up to date as the host fixes them. */
  issues: FieldIssue[];
  /** Changes every time a save is refused, so the summary is announced and focused again. */
  summarySeq: number;
  openIndex: number | null;
  onOpen: (index: number | null) => void;
  saveStatus: SaveStatus;
  /** Why a save failed for a reason other than validation or a conflict. */
  saveError: string | null;
  /** The server has a newer version of this quiz (HTTP 409). */
  conflict: boolean;
  dirty: boolean;
  urlFor: (key: string) => string;
  /** Ids of the questions an upload is running for. */
  uploading: readonly string[];
  uploadError: { questionId: string; message: string } | null;
  onSave: () => void;
  onReload: () => void;
  onOverwrite: () => void;
  onFile: (questionId: string, file: File) => void;
  displayName: string | null;
  onSignOut: () => void;
  /**
   * The host tried to leave (a link, Back, Sign out) with unsaved changes, and is being asked.
   * The container holds what was stopped; this only shows the question.
   */
  leaving: boolean;
  onConfirmLeave: () => void;
  onCancelLeave: () => void;
}

const range = (from: number, to: number) =>
  Array.from({ length: to - from + 1 }, (_, i) => String(from + i));

/** Focuses the control an issue is about, walking up the path if that exact control is gone. */
function focusField(id: string): boolean {
  const parts = id.split('-');
  for (let n = parts.length; n >= 2; n--) {
    const el = document.getElementById(parts.slice(0, n).join('-'));
    if (el) {
      el.scrollIntoView({ block: 'center' });
      el.focus({ preventScroll: true });
      return true;
    }
  }
  return false;
}

function ErrorSummary({
  issues,
  seq,
  onPick,
}: {
  issues: FieldIssue[];
  seq: number;
  onPick: (issue: FieldIssue) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (seq > 0) ref.current?.focus();
  }, [seq]);
  return (
    <div
      ref={ref}
      tabIndex={-1}
      role="alert"
      className={styles.summary}
      data-testid="error-summary"
    >
      <h2 className={styles.summaryTitle}>
        {issues.length === 1 ? 'There is 1 problem' : `There are ${issues.length} problems`}
      </h2>
      <ul className={styles.summaryList}>
        {issues.map((issue) => (
          <li key={`${issue.fieldId}|${issue.message}`}>
            <a
              href={`#${issue.fieldId}`}
              onClick={(e) => {
                e.preventDefault();
                onPick(issue);
              }}
            >
              {issue.message}
            </a>
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * The quiz editor: title and settings, then the ordered questions. Fully controlled by its
 * container, so every edit goes through the pure functions in `state/editor.ts`.
 */
export function EditorScreen(p: EditorScreenProps) {
  const { draft } = p;
  const [newType, setNewType] = useState<QuestionType>('single');
  const [pendingDelete, setPendingDelete] = useState<number | null>(null);
  const [focusAfter, setFocusAfter] = useState<string | null>(null);
  // Where focus goes once a list edit has removed or moved the control that had it.
  const [refocus, setRefocus] = useState<
    | { kind: 'move'; questionId: string; button: 'move-up' | 'move-down' }
    | { kind: 'deleted'; index: number }
    | null
  >(null);
  const byField = issuesByField(p.issues);
  const errorOf = (id: string) =>
    byField
      .get(id)
      ?.map((i) => i.message)
      .join(' ');

  // After the question that holds a broken field has opened, move focus into it.
  useEffect(() => {
    if (focusAfter === null) return;
    const id = window.setTimeout(() => {
      focusField(focusAfter);
      setFocusAfter(null);
    }, 0);
    return () => window.clearTimeout(id);
  }, [focusAfter, p.openIndex]);

  // Runs after the confirmation dialog has closed (its effect is a child's, so it runs first),
  // and only if focus really was lost: a moved card can be re-inserted by the browser, and a
  // deleted question takes its Delete button, and the dialog's way back, with it.
  useEffect(() => {
    if (refocus === null) return;
    setRefocus(null);
    if (refocus.kind === 'move') {
      rescueFocus(
        document.querySelector<HTMLElement>(
          `[data-question-id="${refocus.questionId}"] [data-focus="${refocus.button}"]`,
        ),
      );
      return;
    }
    // The next question is now at the deleted one's place; after the last, the add control.
    rescueFocus(
      document.querySelector<HTMLElement>(
        `[data-question="${refocus.index}"] [data-focus="summary"]`,
      ) ?? document.querySelector<HTMLElement>('[data-focus="add-question"]'),
    );
  }, [refocus]);

  const pick = (issue: FieldIssue) => {
    if (issue.question !== null && p.openIndex !== issue.question) p.onOpen(issue.question);
    setFocusAfter(issue.fieldId);
  };

  const status =
    p.saveStatus === 'saving'
      ? 'Saving…'
      : p.saveStatus === 'saved' && !p.dirty
        ? 'All changes saved'
        : p.dirty
          ? 'Unsaved changes'
          : '';

  return (
    <HostShell displayName={p.displayName} onSignOut={p.onSignOut}>
      <div className={styles.page}>
        <header className={styles.pageHead}>
          <h1>{p.isNew ? 'New quiz' : 'Edit quiz'}</h1>
          <div className={styles.saveBar}>
            <StatusLine className={styles.saveStatus}>{status}</StatusLine>
            <Button onClick={p.onSave} disabled={p.saveStatus === 'saving'} size="compact">
              {p.saveStatus === 'saving' ? 'Saving…' : 'Save quiz'}
            </Button>
          </div>
        </header>

        {p.issues.length > 0 && <ErrorSummary issues={p.issues} seq={p.summarySeq} onPick={pick} />}

        {p.conflict && (
          <div role="alert" className={styles.conflict} data-testid="conflict">
            <h2 className={styles.summaryTitle}>This quiz changed elsewhere</h2>
            <p>
              Someone saved a newer version while you were editing, perhaps in another window. Load
              the latest version and lose your changes, or overwrite it with yours.
            </p>
            <div className={styles.row}>
              <Button size="compact" variant="secondary" onClick={p.onReload}>
                Reload the latest version
              </Button>
              <Button size="compact" onClick={p.onOverwrite}>
                Overwrite with my version
              </Button>
            </div>
          </div>
        )}

        {p.saveError && (
          <p role="alert" className={styles.inlineError}>
            {p.saveError}
          </p>
        )}

        <section className={styles.section} aria-labelledby="quiz-title-heading">
          <h2 id="quiz-title-heading" className={styles.h2}>
            Quiz
          </h2>
          <TextField
            fieldId="f-title"
            label="Title"
            value={draft.title}
            counter={`${draft.title.length} / ${LIMITS.quizTitleMax}`}
            error={errorOf('f-title')}
            autoComplete="off"
            onChange={(e) => p.onChange({ ...draft, title: e.target.value })}
          />
          <CheckboxField
            label="Streak bonus"
            hint="Extra points for answering several scored questions in a row."
            checked={draft.settings.streakBonus}
            onChange={(v) =>
              p.onChange({ ...draft, settings: { ...draft.settings, streakBonus: v } })
            }
          />
          <CheckboxField
            label="Show questions on players' devices"
            hint="Off: phones show only the answer options, and the question is on the big screen."
            checked={draft.settings.showQuestionOnDevices}
            onChange={(v) =>
              p.onChange({ ...draft, settings: { ...draft.settings, showQuestionOnDevices: v } })
            }
          />
          <SelectField
            fieldId="f-settings-readSeconds"
            label="Reading time"
            hint="Seconds the question shows before the options open."
            value={String(draft.settings.readSeconds)}
            options={range(0, LIMITS.readSecondsMax).map((v) => ({
              value: v,
              label: `${v} seconds`,
            }))}
            error={errorOf('f-settings-readSeconds')}
            onChange={(v) =>
              p.onChange({ ...draft, settings: { ...draft.settings, readSeconds: Number(v) } })
            }
          />
        </section>

        <section
          className={styles.section}
          aria-labelledby="questions-heading"
          id="f-questions"
          tabIndex={-1}
        >
          <h2 id="questions-heading" className={styles.h2}>
            Questions ({draft.questions.length})
          </h2>
          {errorOf('f-questions') && (
            <p role="alert" className={styles.inlineError}>
              {errorOf('f-questions')}
            </p>
          )}
          <ol className={styles.questions}>
            {draft.questions.map((q, i) => (
              <QuestionCard
                key={q.id}
                index={i}
                count={draft.questions.length}
                question={q}
                open={p.openIndex === i}
                problems={p.issues.filter((issue) => issue.question === i).length}
                errorOf={errorOf}
                urlFor={p.urlFor}
                uploading={p.uploading.includes(q.id)}
                uploadError={p.uploadError?.questionId === q.id ? p.uploadError.message : null}
                onToggle={() => p.onOpen(p.openIndex === i ? null : i)}
                onChange={(next) => p.onChange(replaceQuestion(draft, i, next))}
                onMove={(delta) => {
                  if (i + delta < 0 || i + delta >= draft.questions.length) return;
                  p.onChange(moveQuestion(draft, i, delta));
                  setRefocus({
                    kind: 'move',
                    questionId: q.id,
                    button: delta < 0 ? 'move-up' : 'move-down',
                  });
                  // The open card stays open on the same question: it follows its own move, or
                  // steps aside when the card it swapped with was the open one.
                  if (p.openIndex === i) p.onOpen(i + delta);
                  else if (p.openIndex === i + delta) p.onOpen(i);
                }}
                onDuplicate={() => {
                  const r = duplicateQuestion(draft, i);
                  p.onChange(r.draft);
                  if (r.index >= 0) p.onOpen(r.index);
                }}
                onDelete={() => setPendingDelete(i)}
                onFile={(file) => p.onFile(q.id, file)}
              />
            ))}
          </ol>
          <div className={styles.addRow}>
            <SelectField
              label="New question type"
              hint={QUESTION_TYPES.find((t) => t.type === newType)?.hint}
              value={newType}
              options={QUESTION_TYPES.map((t) => ({ value: t.type, label: t.label }))}
              onChange={(v) => setNewType(v as QuestionType)}
            />
            <Button
              variant="secondary"
              size="compact"
              disabled={draft.questions.length >= LIMITS.questionsMax}
              data-focus="add-question"
              onClick={() => {
                const r = addQuestion(draft, newType);
                p.onChange(r.draft);
                if (r.index >= 0) p.onOpen(r.index);
              }}
            >
              Add question
            </Button>
          </div>
        </section>

        <div className={styles.bottomBar}>
          <Button onClick={p.onSave} disabled={p.saveStatus === 'saving'}>
            {p.saveStatus === 'saving' ? 'Saving…' : 'Save quiz'}
          </Button>
        </div>
      </div>

      <ConfirmDialog
        open={pendingDelete !== null}
        title="Delete this question?"
        body={
          pendingDelete !== null
            ? `Question ${pendingDelete + 1} will be removed from the quiz when you save.`
            : ''
        }
        confirmLabel="Delete question"
        onCancel={() => setPendingDelete(null)}
        onConfirm={() => {
          if (pendingDelete !== null) {
            p.onChange(deleteQuestion(draft, pendingDelete));
            if (p.openIndex !== null) p.onOpen(null);
            setRefocus({ kind: 'deleted', index: pendingDelete });
          }
          setPendingDelete(null);
        }}
      />
      <ConfirmDialog
        open={p.leaving}
        title="Leave without saving?"
        body="You have changes that are not saved. If you leave now they are lost."
        confirmLabel="Leave and lose changes"
        cancelLabel="Keep editing"
        onCancel={p.onCancelLeave}
        onConfirm={p.onConfirmLeave}
      />
    </HostShell>
  );
}
