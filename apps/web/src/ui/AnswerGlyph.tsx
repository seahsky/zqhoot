import { SLOTS } from './slots.ts';
import styles from './AnswerGlyph.module.css';

// 24x24 viewBox. A-D are the shapes from ADR-0016; E and F follow the same construction.
const PATHS = [
  'M12 2L20.66 7V17L12 22L3.34 17V7Z', // A hexagon
  'M9 2h6v7h7v6h-7v7H9v-7H2V9h7z', // B plus
  'M12 2L14.47 8.6L21.51 8.91L15.99 13.3L17.88 20.09L12 16.2L6.12 20.09L8.01 13.3L2.49 8.91L9.53 8.6Z', // C five-point star
  'M2 18a10 10 0 0 1 20 0z', // D dome, flat side down
  'M12 2L21.51 8.91L17.88 20.09H6.12L2.49 8.91Z', // E pentagon
  'M5 2L12 9L19 2L22 5L15 12L22 19L19 22L12 15L5 22L2 19L9 12L2 5Z', // F X-cross
] as const;

/**
 * Shape half of an answer's identity. Decorative: the letter is always rendered as
 * text next to it, so colour and shape are never the only cue (WCAG 1.4.1).
 */
export function AnswerGlyph({ slot, size = 40 }: { slot: number; size?: number }) {
  const path = PATHS[slot];
  const token = SLOTS[slot]?.token;
  if (!path || !token) return null;
  return (
    <svg
      className={styles.glyph}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      aria-hidden="true"
      focusable="false"
    >
      <path d={path} style={{ fill: `var(${token})` }} className={styles.shape} />
    </svg>
  );
}
