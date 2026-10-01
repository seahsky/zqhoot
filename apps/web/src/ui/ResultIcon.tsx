import styles from './ResultIcon.module.css';

export type ResultKind = 'correct' | 'incorrect' | 'unscored' | 'no-answer';

/**
 * Icon half of a result. Always paired with words on screen. The shapes differ (filled
 * disc with a tick, ring with a slash, ring with a dash, ring with a dot) so they read
 * without colour. None of them reuses an answer glyph, which never implies correctness.
 */
export function ResultIcon({ kind, size = 56 }: { kind: ResultKind; size?: number }) {
  return (
    <svg
      className={styles.icon}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      aria-hidden="true"
      focusable="false"
    >
      <circle cx="12" cy="12" r="10" className={kind === 'correct' ? styles.filled : styles.ring} />
      {kind === 'correct' && <path d="M7 12.5l3.2 3.2L17 8.6" className={styles.markInverse} />}
      {kind === 'incorrect' && <path d="M6.2 6.2l11.6 11.6" className={styles.mark} />}
      {kind === 'no-answer' && <path d="M7.5 12h9" className={styles.mark} />}
      {kind === 'unscored' && <circle cx="12" cy="12" r="3" className={styles.dot} />}
    </svg>
  );
}
