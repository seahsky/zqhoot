import s from './Present.module.css';

/**
 * The running header of a question or results screen: where the game is, and how many have
 * answered. It is the first block of the screen, in the flow of the stage's top safe area (the
 * same 5u as the lobby and the boards), so a projector that crops its edges keeps both readouts.
 * Its height is a fixed `TOPLINE_U` (layout.ts) so the count coming and going moves nothing.
 */
export function Topline({ eyebrow, count }: { eyebrow: string; count: string | null }) {
  return (
    <div className={s.topline}>
      <p className={s.eyebrow}>{eyebrow}</p>
      {count && (
        <p className={s.count} data-testid="answer-count">
          {count}
        </p>
      )}
    </div>
  );
}
