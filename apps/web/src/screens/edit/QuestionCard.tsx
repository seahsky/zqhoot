import { LIMITS } from '@zqhoot/protocol';
import type { PointsMultiplier, Question, QuestionType } from '@zqhoot/protocol';
import {
  POINTS_CHOICES,
  QUESTION_TYPES,
  TIME_LIMIT_CHOICES,
  addOption,
  canAddOption,
  canRemoveOption,
  changeQuestionType,
  fieldId,
  hasPointsChoice,
  removeOption,
  timeLimitLabel,
  typeLabel,
} from '../../state/editor.ts';
import { SLOTS } from '../../ui/slots.ts';
import { Button } from '../../ui/Button.tsx';
import { CheckboxField, RadioGroup, SelectField } from '../../ui/Controls.tsx';
import { TextArea, TextField } from '../../ui/TextField.tsx';
import { ImageField } from './ImageField.tsx';
import styles from './Editor.module.css';

export interface QuestionCardProps {
  index: number;
  count: number;
  question: Question;
  open: boolean;
  errorOf: (fieldId: string) => string | undefined;
  urlFor: (key: string) => string;
  uploading: boolean;
  uploadError: string | null;
  onToggle: () => void;
  onChange: (q: Question) => void;
  onMove: (delta: -1 | 1) => void;
  onDuplicate: () => void;
  onDelete: () => void;
  onFile: (file: File) => void;
}

const range = (from: number, to: number) =>
  Array.from({ length: to - from + 1 }, (_, i) => String(from + i));

/** What the collapsed card says about the question. */
function summaryText(q: Question): string {
  return q.prompt.trim() === '' ? 'No question text yet' : q.prompt;
}

function OptionsEditor({
  q,
  index,
  errorOf,
  onChange,
}: {
  q: Extract<Question, { type: 'single' | 'poll' }>;
  index: number;
  errorOf: QuestionCardProps['errorOf'];
  onChange: (q: Question) => void;
}) {
  return (
    <div className={styles.options}>
      <h4 className={styles.h4}>Answers</h4>
      {errorOf(fieldId(['questions', index, 'options'])) && (
        <p role="alert" className={styles.inlineError}>
          {errorOf(fieldId(['questions', index, 'options']))}
        </p>
      )}
      <ol className={styles.optionList}>
        {q.options.map((o, j) => {
          const letter = SLOTS[j]?.letter ?? String(j + 1);
          return (
            <li key={o.id} className={styles.optionRow}>
              <div className={styles.optionField}>
                <TextField
                  fieldId={fieldId(['questions', index, 'options', j, 'text'])}
                  label={`Answer ${letter}`}
                  value={o.text}
                  counter={`${o.text.length} / ${LIMITS.optionTextMax}`}
                  error={errorOf(fieldId(['questions', index, 'options', j, 'text']))}
                  autoComplete="off"
                  onChange={(e) =>
                    onChange({
                      ...q,
                      options: q.options.map((x, k) =>
                        k === j ? { ...x, text: e.target.value } : x,
                      ),
                    } as Question)
                  }
                />
              </div>
              {canRemoveOption(q) && (
                <Button
                  size="compact"
                  variant="secondary"
                  onClick={() => onChange(removeOption(q, j))}
                  aria-label={`Remove answer ${letter}`}
                >
                  Remove
                </Button>
              )}
            </li>
          );
        })}
      </ol>
      {canAddOption(q) && (
        <div>
          <Button size="compact" variant="secondary" onClick={() => onChange(addOption(q))}>
            Add answer
          </Button>
        </div>
      )}
    </div>
  );
}

function TypeFields({
  q,
  index,
  errorOf,
  onChange,
}: {
  q: Question;
  index: number;
  errorOf: QuestionCardProps['errorOf'];
  onChange: (q: Question) => void;
}) {
  switch (q.type) {
    case 'single':
      return (
        <>
          <OptionsEditor q={q} index={index} errorOf={errorOf} onChange={onChange} />
          <RadioGroup
            fieldId={fieldId(['questions', index, 'correctOptionId'])}
            legend="Correct answer"
            name={`correct-${q.id}`}
            value={q.correctOptionId}
            error={errorOf(fieldId(['questions', index, 'correctOptionId']))}
            options={q.options.map((o, j) => ({
              value: o.id,
              label: `${SLOTS[j]?.letter ?? j + 1} · ${o.text.trim() === '' ? '(no text yet)' : o.text}`,
            }))}
            onChange={(id) => onChange({ ...q, correctOptionId: id })}
          />
        </>
      );
    case 'truefalse':
      return (
        <RadioGroup
          fieldId={fieldId(['questions', index, 'correct'])}
          legend="Correct answer"
          name={`correct-${q.id}`}
          value={q.correct ? 'true' : 'false'}
          inline
          options={[
            { value: 'true', label: 'True' },
            { value: 'false', label: 'False' },
          ]}
          onChange={(v) => onChange({ ...q, correct: v === 'true' })}
        />
      );
    case 'poll':
      return <OptionsEditor q={q} index={index} errorOf={errorOf} onChange={onChange} />;
    case 'wordcloud':
      return (
        <SelectField
          fieldId={fieldId(['questions', index, 'maxEntries'])}
          label="Words per player"
          hint="Each player can send up to this many words."
          value={String(q.maxEntries)}
          options={range(1, LIMITS.wordEntriesMax).map((v) => ({ value: v, label: v }))}
          error={errorOf(fieldId(['questions', index, 'maxEntries']))}
          onChange={(v) => onChange({ ...q, maxEntries: Number(v) })}
        />
      );
    case 'open':
      return (
        <>
          <SelectField
            fieldId={fieldId(['questions', index, 'maxEntries'])}
            label="Responses per player"
            value={String(q.maxEntries)}
            options={range(1, LIMITS.openEntriesMax).map((v) => ({ value: v, label: v }))}
            error={errorOf(fieldId(['questions', index, 'maxEntries']))}
            onChange={(v) => onChange({ ...q, maxEntries: Number(v) })}
          />
          <CheckboxField
            fieldId={fieldId(['questions', index, 'requireApproval'])}
            label="Approve responses before they show"
            hint="On: nothing appears on the big screen until you show it. Off: responses show at once, and you can still hide them."
            checked={q.requireApproval}
            onChange={(checked) => onChange({ ...q, requireApproval: checked })}
          />
        </>
      );
    case 'rating':
      return (
        <>
          <SelectField
            fieldId={fieldId(['questions', index, 'max'])}
            label="Scale"
            hint="Players pick a number from 1 up to this."
            value={String(q.max)}
            options={range(LIMITS.ratingMaxMin, LIMITS.ratingMaxMax).map((v) => ({
              value: v,
              label: `1 to ${v}`,
            }))}
            error={errorOf(fieldId(['questions', index, 'max']))}
            onChange={(v) => onChange({ ...q, max: Number(v) })}
          />
          <TextField
            fieldId={fieldId(['questions', index, 'minLabel'])}
            label="Label for 1 (optional)"
            value={q.minLabel ?? ''}
            counter={`${(q.minLabel ?? '').length} / ${LIMITS.ratingLabelMax}`}
            error={errorOf(fieldId(['questions', index, 'minLabel']))}
            autoComplete="off"
            onChange={(e) =>
              onChange({ ...q, minLabel: e.target.value === '' ? undefined : e.target.value })
            }
          />
          <TextField
            fieldId={fieldId(['questions', index, 'maxLabel'])}
            label={`Label for ${q.max} (optional)`}
            value={q.maxLabel ?? ''}
            counter={`${(q.maxLabel ?? '').length} / ${LIMITS.ratingLabelMax}`}
            error={errorOf(fieldId(['questions', index, 'maxLabel']))}
            autoComplete="off"
            onChange={(e) =>
              onChange({ ...q, maxLabel: e.target.value === '' ? undefined : e.target.value })
            }
          />
        </>
      );
  }
}

/**
 * One question: a summary row with move up and down, duplicate and delete (buttons, never
 * drag-only: WCAG 2.5.7), and, when open, every field for its type.
 */
export function QuestionCard(p: QuestionCardProps) {
  const { question: q, index } = p;
  const bodyId = `question-body-${q.id}`;
  return (
    <li className={styles.card} data-question={index}>
      <div className={styles.cardHead}>
        <button
          type="button"
          className={styles.summaryButton}
          aria-expanded={p.open}
          aria-controls={bodyId}
          onClick={p.onToggle}
        >
          <span className={styles.number}>{index + 1}</span>
          <span className={styles.summaryText}>
            <span className={styles.type}>{typeLabel(q.type)}</span>
            <span className={styles.preview}>{summaryText(q)}</span>
          </span>
        </button>
        <div className={styles.cardActions}>
          <Button
            size="compact"
            variant="secondary"
            onClick={() => p.onMove(-1)}
            disabled={index === 0}
            aria-label={`Move up, question ${index + 1}`}
          >
            Move up
          </Button>
          <Button
            size="compact"
            variant="secondary"
            onClick={() => p.onMove(1)}
            disabled={index === p.count - 1}
            aria-label={`Move down, question ${index + 1}`}
          >
            Move down
          </Button>
          <Button
            size="compact"
            variant="secondary"
            onClick={p.onDuplicate}
            aria-label={`Duplicate, question ${index + 1}`}
          >
            Duplicate
          </Button>
          <Button
            size="compact"
            variant="secondary"
            onClick={p.onDelete}
            aria-label={`Delete, question ${index + 1}`}
          >
            Delete
          </Button>
        </div>
      </div>

      {p.open && (
        <div id={bodyId} className={styles.body}>
          <SelectField
            label="Question type"
            value={q.type}
            options={QUESTION_TYPES.map((t) => ({ value: t.type, label: t.label }))}
            onChange={(v) => p.onChange(changeQuestionType(q, v as QuestionType))}
          />
          <TextArea
            fieldId={fieldId(['questions', index, 'prompt'])}
            label="Question"
            value={q.prompt}
            rows={3}
            counter={`${q.prompt.length} / ${LIMITS.questionPromptMax}`}
            error={p.errorOf(fieldId(['questions', index, 'prompt']))}
            onChange={(e) => p.onChange({ ...q, prompt: e.target.value })}
          />
          <ImageField
            fieldId={fieldId(['questions', index, 'imageKey'])}
            imageKey={q.imageKey}
            urlFor={p.urlFor}
            uploading={p.uploading}
            error={p.uploadError ?? p.errorOf(fieldId(['questions', index, 'imageKey'])) ?? null}
            onFile={p.onFile}
            onRemove={() => {
              const { imageKey: _removed, ...rest } = q;
              p.onChange(rest as Question);
            }}
          />
          <TypeFields q={q} index={index} errorOf={p.errorOf} onChange={p.onChange} />
          <div className={styles.pair}>
            <SelectField
              fieldId={fieldId(['questions', index, 'timeLimitSec'])}
              label="Time limit"
              value={q.timeLimitSec === null ? 'none' : String(q.timeLimitSec)}
              options={TIME_LIMIT_CHOICES.map((t) => ({
                value: t === null ? 'none' : String(t),
                label: timeLimitLabel(t),
              }))}
              error={p.errorOf(fieldId(['questions', index, 'timeLimitSec']))}
              onChange={(v) => p.onChange({ ...q, timeLimitSec: v === 'none' ? null : Number(v) })}
            />
            {hasPointsChoice(q) && (
              <SelectField
                fieldId={fieldId(['questions', index, 'points'])}
                label="Points"
                value={String(q.points)}
                options={POINTS_CHOICES.map((c) => ({ value: String(c.value), label: c.label }))}
                error={p.errorOf(fieldId(['questions', index, 'points']))}
                onChange={(v) => p.onChange({ ...q, points: Number(v) as PointsMultiplier })}
              />
            )}
          </div>
        </div>
      )}
    </li>
  );
}
