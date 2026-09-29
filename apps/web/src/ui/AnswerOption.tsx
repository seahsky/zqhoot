import { AnswerGlyph } from './AnswerGlyph.tsx';
import { cx } from './cx.ts';
import { SLOTS } from './slots.ts';
import styles from './AnswerOption.module.css';

export interface AnswerOptionProps {
  /** 0-5, which fixes the letter, glyph and colour. */
  slot: number;
  text: string;
  /** Omit for a non-interactive display of the option (e.g. the one you locked in). */
  onSelect?: () => void;
  /** Visible but inert, e.g. during the get-ready count-in. */
  disabled?: boolean;
  /** Marks the player's own pick. */
  chosen?: boolean;
}

/** A 72px+ row: glyph, letter and text on a neutral card with an ink outline. */
export function AnswerOption({ slot, text, onSelect, disabled, chosen }: AnswerOptionProps) {
  const letter = SLOTS[slot]?.letter ?? '';
  const body = (
    <>
      <AnswerGlyph slot={slot} />
      <span className={styles.letter}>{letter}</span>
      <span className={styles.text}>{text}</span>
    </>
  );
  const className = cx(styles.option, chosen && styles.chosen, disabled && styles.disabled);
  if (!onSelect) {
    return <div className={className}>{body}</div>;
  }
  return (
    <button type="button" className={className} onClick={onSelect} disabled={disabled}>
      {body}
    </button>
  );
}
