import { useId } from 'react';
import type { CSSProperties } from 'react';
import { ratingColumns } from './ratingLayout.ts';
import styles from './RatingScale.module.css';

export interface RatingScaleProps {
  max: number;
  minLabel?: string;
  maxLabel?: string;
  onSelect: (value: number) => void;
  disabled?: boolean;
}

/**
 * 1..max in balanced rows (one row when the column is wide enough), with the end labels
 * underneath.
 */
export function RatingScale({ max, minLabel, maxLabel, onSelect, disabled }: RatingScaleProps) {
  const labelId = useId();
  const values = Array.from({ length: max }, (_, i) => i + 1);
  const layout = { '--cols': ratingColumns(max), '--count': max } as CSSProperties;
  return (
    <div className={styles.scale}>
      <p id={labelId} className={styles.caption}>
        1 to {max}
      </p>
      <div className={styles.container}>
        <div role="group" aria-labelledby={labelId} className={styles.buttons} style={layout}>
          {values.map((v) => (
            <button
              key={v}
              type="button"
              className={styles.button}
              disabled={disabled}
              onClick={() => onSelect(v)}
            >
              {v}
            </button>
          ))}
        </div>
      </div>
      {(minLabel || maxLabel) && (
        <div className={styles.labels}>
          <span>{minLabel ? `1: ${minLabel}` : ''}</span>
          <span>{maxLabel ? `${max}: ${maxLabel}` : ''}</span>
        </div>
      )}
    </div>
  );
}
