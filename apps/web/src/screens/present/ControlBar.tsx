import type { TextScale } from '../../ui/Stage.tsx';
import s from './ControlBar.module.css';

export interface ControlBarProps {
  /** Label of the big advance action ("Start", "End question", ...), or null when there is none. */
  nextLabel: string | null;
  /** A question is open, so the host may end it now. */
  canClose: boolean;
  locked: boolean;
  textScale: TextScale;
  dark: boolean;
  fullscreen: boolean;
  /** The bar fades out; it stays in the tab order and comes back on focus or hover. */
  hidden: boolean;
  onNext: () => void;
  onClose: () => void;
  onLock: () => void;
  onTextSize: () => void;
  onTheme: () => void;
  onFullscreen: () => void;
  onHelp: () => void;
  onToggleHidden: () => void;
}

/**
 * Every keyboard shortcut also has a button here, in a thin bar. "Hide controls" fades the bar
 * for the room; it is still reachable with Tab, and shows itself while it holds focus.
 */
export function ControlBar(p: ControlBarProps) {
  return (
    <div
      className={s.bar}
      role="toolbar"
      aria-label="Presenter controls"
      data-hidden={p.hidden ? 'true' : undefined}
    >
      {p.nextLabel !== null && (
        <button type="button" className={`${s.button} ${s.primary}`} onClick={p.onNext}>
          {p.nextLabel}
        </button>
      )}
      {p.canClose && (
        <button type="button" className={s.button} onClick={p.onClose}>
          End question
        </button>
      )}
      <button type="button" className={s.button} onClick={p.onLock} aria-pressed={p.locked}>
        {p.locked ? 'Unlock joining' : 'Lock joining'}
      </button>
      <button type="button" className={s.button} onClick={p.onTextSize}>
        Text size {Math.round(p.textScale * 100)}%
      </button>
      <button type="button" className={s.button} onClick={p.onTheme}>
        {p.dark ? 'Light screen' : 'Dark screen'}
      </button>
      <button
        type="button"
        className={s.button}
        onClick={p.onFullscreen}
        aria-pressed={p.fullscreen}
      >
        {p.fullscreen ? 'Exit full screen' : 'Full screen'}
      </button>
      <button type="button" className={s.button} onClick={p.onHelp}>
        Shortcuts (?)
      </button>
      <button type="button" className={s.button} onClick={p.onToggleHidden} aria-pressed={p.hidden}>
        {p.hidden ? 'Show controls' : 'Hide controls'}
      </button>
    </div>
  );
}
