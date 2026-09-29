import { useId, useRef, useState } from 'react';
import { IMAGE_CONTENT_TYPES } from '@zqhoot/protocol';
import buttonStyles from '../../ui/Button.module.css';
import { Button } from '../../ui/Button.tsx';
import { cx } from '../../ui/cx.ts';
import fieldStyles from '../../ui/TextField.module.css';
import styles from './Editor.module.css';

export interface ImageFieldProps {
  fieldId: string;
  /** The stored key, or undefined when the question has no picture. */
  imageKey: string | undefined;
  /** Resolves a key to the URL to preview (`mediaBaseUrl + key`). */
  urlFor: (key: string) => string;
  /** An upload for this question is in flight. */
  uploading: boolean;
  /** Why the last upload was refused or failed. */
  error: string | null;
  onFile: (file: File) => void;
  onRemove: () => void;
}

const ACCEPT = IMAGE_CONTENT_TYPES.join(',');

/**
 * Picks a picture for a question. The browser is only asked for PNG, JPEG, WebP or GIF, and the
 * upload code refuses anything else (and files over 5 MB) before it asks the server for a grant.
 *
 * The native file input is visually hidden, not removed: it keeps keyboard focus and its label,
 * and a label styled as a button opens it. That also drops the native "No file chosen" text,
 * which contradicted the picture beside it.
 */
export function ImageField({
  fieldId,
  imageKey,
  urlFor,
  uploading,
  error,
  onFile,
  onRemove,
}: ImageFieldProps) {
  const uid = useId();
  const input = useRef<HTMLInputElement>(null);
  const [fileName, setFileName] = useState('');
  const hintId = `${uid}-hint`;
  const errorId = `${uid}-error`;
  return (
    <div className={fieldStyles.field} id={fieldId} tabIndex={-1}>
      <label htmlFor={`${uid}-file`} className={fieldStyles.label}>
        Image (optional)
      </label>
      <p id={hintId} className={fieldStyles.hint}>
        PNG, JPEG, WebP or GIF, up to 5 MB. Photos may carry their location: remove that first.
      </p>
      {imageKey && (
        <div className={styles.picture}>
          <img src={urlFor(imageKey)} alt="Preview of this question's image" />
        </div>
      )}
      <div className={styles.imageActions}>
        <input
          ref={input}
          id={`${uid}-file`}
          type="file"
          accept={ACCEPT}
          className={styles.file}
          disabled={uploading}
          aria-describedby={[hintId, error ? errorId : null].filter(Boolean).join(' ')}
          onChange={(e) => {
            const file = e.target.files?.[0];
            // Reset so choosing the same file again (after a refusal) still fires a change.
            if (input.current) input.current.value = '';
            if (file) {
              setFileName(file.name);
              onFile(file);
            }
          }}
        />
        <label
          htmlFor={`${uid}-file`}
          className={cx(
            buttonStyles.button,
            buttonStyles.secondary,
            buttonStyles.compact,
            styles.fileButton,
            styles.tall,
          )}
        >
          {imageKey ? 'Replace image' : 'Choose image'}
        </label>
        {imageKey && (
          <Button
            size="compact"
            variant="secondary"
            className={styles.tall}
            onClick={onRemove}
            disabled={uploading}
          >
            Remove image
          </Button>
        )}
      </div>
      <p role="status" className={styles.status}>
        {uploading ? (fileName ? `Uploading ${fileName}…` : 'Uploading…') : ''}
      </p>
      {error && (
        <p id={errorId} role="alert" className={fieldStyles.error}>
          <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true" focusable="false">
            <path d="M12 3 22 21H2Z" className={fieldStyles.errorIcon} />
            <path d="M12 10v5M12 17.5v.5" className={fieldStyles.errorMark} />
          </svg>
          <span>{error}</span>
        </p>
      )}
    </div>
  );
}
