import { useEffect, useId, useRef } from 'react';
import { Button } from './Button.tsx';
import styles from './ConfirmDialog.module.css';

export interface ConfirmDialogProps {
  open: boolean;
  title: string;
  /** What will happen, in a sentence or two. */
  body: string;
  confirmLabel: string;
  cancelLabel?: string;
  onConfirm: () => void;
  onCancel: () => void;
}

/**
 * A native modal `<dialog>`: focus is trapped, Escape cancels, and focus goes back to the
 * button that opened it. Focus starts on Cancel, so a stray Enter never confirms.
 */
export function ConfirmDialog({
  open,
  title,
  body,
  confirmLabel,
  cancelLabel = 'Cancel',
  onConfirm,
  onCancel,
}: ConfirmDialogProps) {
  const ref = useRef<HTMLDialogElement>(null);
  // Several dialogs can sit on one page (closed ones stay in the DOM), so ids must be unique.
  const uid = useId();
  const titleId = `${uid}-title`;
  const bodyId = `${uid}-body`;

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);

  return (
    <dialog
      ref={ref}
      className={styles.dialog}
      aria-labelledby={titleId}
      aria-describedby={bodyId}
      onCancel={(e) => {
        // Escape: let the state decide, so the dialog and the parent cannot disagree.
        e.preventDefault();
        onCancel();
      }}
    >
      <h2 id={titleId} className={styles.title}>
        {title}
      </h2>
      <p id={bodyId} className={styles.body}>
        {body}
      </p>
      <div className={styles.actions}>
        <Button variant="secondary" size="compact" onClick={onCancel} autoFocus>
          {cancelLabel}
        </Button>
        <Button size="compact" onClick={onConfirm}>
          {confirmLabel}
        </Button>
      </div>
    </dialog>
  );
}
