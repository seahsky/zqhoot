import type { Figure } from './figures.ts';
import styles from './play.module.css';

/**
 * Facts as labelled figures with a rule between them, so "2,340 points" and "2nd place"
 * never run together as one line. An optional note above says what the figures are about.
 */
export function StatCard({ note, figures }: { note?: string; figures: readonly Figure[] }) {
  return (
    <div className={styles.card}>
      {note && <p className={styles.cardNote}>{note}</p>}
      <p className={styles.figures}>
        {figures.map((f) => (
          <span key={f.label} className={styles.figure}>
            <span className={`${styles.figureValue} tabular`}>{f.value}</span>{' '}
            <span className={styles.figureLabel}>{f.label}</span>
          </span>
        ))}
      </p>
    </div>
  );
}
