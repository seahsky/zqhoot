import { LIMITS } from '@zqhoot/protocol';
import type { AnswerPayload, PublicQuestion } from '@zqhoot/protocol';
import type { DraftRestore } from '../../state/player.ts';
import { ChoiceList } from './ChoiceList.tsx';
import { RatingScale } from './RatingScale.tsx';
import { TextEntry } from './TextEntry.tsx';

const TRUE_FALSE = [
  { id: 'true', text: 'True' },
  { id: 'false', text: 'False' },
] as const;

export interface AnswerInputProps {
  question: PublicQuestion;
  /** Returns whether the answer was sent; only text entries care (see `TextEntry`). */
  onAnswer: (payload: AnswerPayload) => boolean;
  /** Visible but inert (get-ready). */
  disabled?: boolean;
  /** Text entries already sent, for word cloud and open-ended questions. */
  sentTexts?: readonly string[];
  /** Entries a word cloud or open-ended question still accepts. */
  remaining?: number;
  /** Text the server refused, to put back into the entry field. */
  restore?: DraftRestore;
}

/** The control for whichever kind of question this is. */
export function AnswerInput({
  question,
  onAnswer,
  disabled,
  sentTexts = [],
  remaining,
  restore,
}: AnswerInputProps) {
  switch (question.type) {
    case 'single':
    case 'poll':
      return (
        <ChoiceList
          options={question.options}
          disabled={disabled}
          onSelect={(i) => {
            const option = question.options[i];
            if (option) onAnswer({ kind: 'choice', optionId: option.id });
          }}
        />
      );
    case 'truefalse':
      return (
        <ChoiceList
          options={TRUE_FALSE}
          disabled={disabled}
          onSelect={(i) => onAnswer({ kind: 'boolean', value: i === 0 })}
        />
      );
    case 'rating':
      return (
        <RatingScale
          max={question.max}
          minLabel={question.minLabel}
          maxLabel={question.maxLabel}
          disabled={disabled}
          onSelect={(value) => onAnswer({ kind: 'rating', value })}
        />
      );
    case 'wordcloud':
    case 'open':
      return (
        <TextEntry
          kind={question.type}
          maxLength={question.type === 'wordcloud' ? LIMITS.wordMaxLength : LIMITS.openTextMax}
          remaining={remaining ?? question.maxEntries}
          entries={sentTexts}
          disabled={disabled}
          restore={restore}
          onSubmit={(text) => onAnswer({ kind: 'text', text })}
        />
      );
  }
}
