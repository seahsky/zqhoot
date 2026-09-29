import { useEffect, useRef } from 'react';
import { SHORTCUTS } from './keys.ts';
import s from './HelpOverlay.module.css';

/**
 * A native modal `<dialog>`: it traps focus, closes on Escape, and returns focus to the button
 * that opened it. `open` is the source of truth; the dialog's own close event (Escape) is
 * reported through `onClose` so the state follows.
 */
export function HelpOverlay({ open, onClose }: { open: boolean; onClose: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);

  return (
    <dialog
      ref={ref}
      className={s.dialog}
      aria-labelledby="help-title"
      onClose={onClose}
      data-testid="help-overlay"
    >
      <h2 id="help-title" className={s.title}>
        Keyboard shortcuts
      </h2>
      <dl className={s.list}>
        {SHORTCUTS.map((sc) => (
          <div key={sc.does} className={s.row}>
            <dt className={s.keys}>
              {sc.keys.map((k) => (
                <kbd key={k} className={s.key}>
                  {k}
                </kbd>
              ))}
            </dt>
            <dd className={s.does}>{sc.does}</dd>
          </div>
        ))}
      </dl>
      <p className={s.note}>The left arrow does nothing, so a clicker's back button is safe.</p>
      <button type="button" className={s.close} onClick={onClose}>
        Close
      </button>
    </dialog>
  );
}
