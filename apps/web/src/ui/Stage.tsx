import { useEffect } from 'react';
import type { CSSProperties, ReactNode } from 'react';
import styles from './Stage.module.css';

export type TextScale = 1 | 1.25 | 1.5;

export const TEXT_SCALES: readonly TextScale[] = [1, 1.25, 1.5];

export interface StageProps {
  /** The text-size control: multiplies the essential text sizes (ADR-0016, WCAG F94). */
  textScale?: TextScale;
  children: ReactNode;
}

/**
 * A 16:9 box letterboxed in the viewport. Everything inside sizes itself in stage units
 * (`--u`, 1% of the stage height), so 1366x768, 1920x1080 and 3840x2160 draw the same
 * composition. Controls do not live inside it: they sit in the letterbox or in the stage's
 * bottom margin, out of the way of the layout that is being measured.
 */
export function Stage({ textScale = 1, children }: StageProps) {
  // A projector view never scrolls, and a scrollbar would also make `100vw` wider than the page.
  useEffect(() => {
    const root = document.documentElement;
    root.classList.add('stage-page');
    return () => root.classList.remove('stage-page');
  }, []);

  return (
    <div className={styles.frame}>
      <div
        className={styles.stage}
        data-testid="stage"
        style={{ '--scale': textScale } as CSSProperties}
      >
        <div className={styles.body}>{children}</div>
      </div>
    </div>
  );
}
