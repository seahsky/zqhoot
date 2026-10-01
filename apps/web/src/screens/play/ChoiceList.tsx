import { graphemeCount } from '../../state/format.ts';
import { AnswerOption } from '../../ui/AnswerOption.tsx';
import styles from './ChoiceList.module.css';

/** ADR-0016: the 2x2 layout is only for options short enough to sit side by side. */
export const COMPACT_MAX_CHARS = 24;

export interface ChoiceListProps {
  options: ReadonlyArray<{ id: string; text: string }>;
  onSelect: (index: number) => void;
  disabled?: boolean;
}

/**
 * Stacked rows below a 420px container width; 2 columns above it when every option is
 * short. DOM order stays A, B, C, D in both layouts (WCAG 2.4.3).
 */
export function ChoiceList({ options, onSelect, disabled }: ChoiceListProps) {
  const compact = options.every((o) => graphemeCount(o.text) <= COMPACT_MAX_CHARS);
  return (
    <div className={styles.container}>
      <ul className={styles.list} data-compact={compact}>
        {options.map((option, i) => (
          <li key={option.id}>
            <AnswerOption
              slot={i}
              text={option.text}
              disabled={disabled}
              onSelect={() => onSelect(i)}
            />
          </li>
        ))}
      </ul>
    </div>
  );
}
