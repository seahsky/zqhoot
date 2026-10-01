import { useEffect, useState } from 'react';
import { timerTier } from '../state/format.ts';
import { StatusLine } from './StatusLine.tsx';
import styles from './Countdown.module.css';

export interface CountdownProps {
  /** null means the question is untimed. */
  secondsLeft: number | null;
  /** 1 at opening down to 0 at the deadline; null when untimed. */
  fraction: number | null;
}

/**
 * Numeral plus a shrinking outline bar (hidden under prefers-reduced-motion, where the
 * numeral alone updates once per second). Nothing flashes or pulses. Screen readers get
 * a coarse spoken update instead of one per second.
 */
export function Countdown({ secondsLeft, fraction }: CountdownProps) {
  const tier = secondsLeft === null || secondsLeft <= 0 ? null : timerTier(secondsLeft);
  const [spoken, setSpoken] = useState('');
  useEffect(() => {
    setSpoken(secondsLeft === null || secondsLeft <= 0 ? '' : `${secondsLeft} seconds left`);
    // Keyed on the tier alone: `secondsLeft` is deliberately read only when it changes,
    // so the spoken text updates coarsely instead of every second.
  }, [tier]);

  if (secondsLeft === null) {
    return <p className={styles.untimed}>No time limit</p>;
  }
  return (
    <div className={styles.countdown}>
      <div className={styles.row}>
        <span className={styles.numeral} role="timer" aria-label="Time left in seconds">
          {secondsLeft}
        </span>
        <span className={styles.unit} aria-hidden="true">
          {secondsLeft === 1 ? 'second left' : 'seconds left'}
        </span>
      </div>
      {fraction !== null && (
        <div className={styles.bar} aria-hidden="true" data-testid="countdown-bar">
          <div className={styles.fill} style={{ width: `${Math.round(fraction * 1000) / 10}%` }} />
        </div>
      )}
      <StatusLine visible={false}>{spoken}</StatusLine>
    </div>
  );
}
