import { useId } from 'react';
import styles from './RatingScale.module.css';

export interface RatingScaleProps {
  max: number;
  minLabel?: string;
  maxLabel?: string;
  onSelect: (value: number) => void;
  disabled?: boolean;
}

/** 1..max in one row that wraps, with the end labels underneath. */
export function RatingScale({ max, minLabel, maxLabel, onSelect, disabled }: RatingScaleProps) {
  const labelId = useId();
  const values = Array.from({ length: max }, (_, i) => i + 1);
  return (
    <div className={styles.scale}>
      <p id={labelId} className={styles.caption}>
        1 to {max}
      </p>
      <div role="group" aria-labelledby={labelId} className={styles.buttons}>
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
      {(minLabel || maxLabel) && (
        <div className={styles.labels}>
          <span>{minLabel ? `1: ${minLabel}` : ''}</span>
          <span>{maxLabel ? `${max}: ${maxLabel}` : ''}</span>
        </div>
      )}
    </div>
  );
}
