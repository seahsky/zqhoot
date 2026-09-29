import { createContext, useContext, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { CSSProperties, ReactNode } from 'react';
import styles from './Stage.module.css';

export type TextScale = 1 | 1.25 | 1.5;

export const TEXT_SCALES: readonly TextScale[] = [1, 1.25, 1.5];

export interface StageProps {
  /** The text-size control: multiplies the essential text sizes (ADR-0016, WCAG F94). */
  textScale?: TextScale;
  children: ReactNode;
}

const StageUnit = createContext(0);

/**
 * How many CSS pixels one stage unit is right now, or 0 before the stage has been measured.
 * Almost everything scales with the unit, but a few controls keep a px floor (a 24 px touch
 * target), so the layout math needs to know where that floor takes over.
 */
export function useStageUnitPx(): number {
  return useContext(StageUnit);
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

  const ref = useRef<HTMLDivElement>(null);
  const [unitPx, setUnitPx] = useState(0);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => setUnitPx(el.getBoundingClientRect().height / 100);
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  return (
    <div className={styles.frame}>
      <div
        ref={ref}
        className={styles.stage}
        data-testid="stage"
        style={{ '--scale': textScale } as CSSProperties}
      >
        <StageUnit.Provider value={unitPx}>
          <div className={styles.body}>{children}</div>
        </StageUnit.Provider>
      </div>
    </div>
  );
}
