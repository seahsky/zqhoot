import { useId } from 'react';
import type { InputHTMLAttributes, ReactNode, Ref, TextareaHTMLAttributes } from 'react';
import { cx } from './cx.ts';
import styles from './TextField.module.css';

interface FrameProps {
  /**
   * Overrides the control's DOM id. The editor's error summary links to fields by a stable id
   * derived from the field's path in the quiz.
   */
  fieldId?: string;
  label: string;
  hint?: string;
  /** Shown inline and announced (`role="alert"`) when it appears. */
  error?: string | null;
  /** Live character count, e.g. "5 / 16". Part of the field's description, not announced per keystroke. */
  counter?: string;
}

interface Ids {
  control: string;
  hint: string;
  error: string;
  counter: string;
}

function useIds(fieldId?: string): Ids {
  const uid = useId();
  return {
    control: fieldId ?? `${uid}-control`,
    hint: `${uid}-hint`,
    error: `${uid}-error`,
    counter: `${uid}-counter`,
  };
}

function controlProps(p: FrameProps, ids: Ids) {
  const described = [p.hint && ids.hint, p.error && ids.error, p.counter && ids.counter].filter(
    Boolean,
  );
  return {
    id: ids.control,
    'aria-invalid': p.error ? (true as const) : undefined,
    'aria-describedby': described.length > 0 ? described.join(' ') : undefined,
  };
}

function Frame({
  label,
  hint,
  error,
  counter,
  ids,
  children,
}: FrameProps & {
  ids: Ids;
  children: ReactNode;
}) {
  return (
    <div className={styles.field}>
      <label htmlFor={ids.control} className={styles.label}>
        {label}
      </label>
      {hint && (
        <p id={ids.hint} className={styles.hint}>
          {hint}
        </p>
      )}
      {children}
      {(error || counter) && (
        <div className={styles.meta}>
          {error ? (
            <p id={ids.error} role="alert" className={styles.error}>
              <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true" focusable="false">
                <path d="M12 3 22 21H2Z" className={styles.errorIcon} />
                <path d="M12 10v5M12 17.5v.5" className={styles.errorMark} />
              </svg>
              <span>{error}</span>
            </p>
          ) : (
            <span />
          )}
          {counter && (
            <span id={ids.counter} className={cx(styles.counter, 'tabular')}>
              {counter}
            </span>
          )}
        </div>
      )}
    </div>
  );
}

export interface TextFieldProps
  extends
    FrameProps,
    Omit<InputHTMLAttributes<HTMLInputElement>, 'id' | 'className' | 'aria-invalid'> {
  /** `code` sets large, widely spaced digits for the PIN. */
  variant?: 'default' | 'code';
  inputRef?: Ref<HTMLInputElement>;
}

export function TextField({
  label,
  hint,
  error,
  counter,
  fieldId,
  variant = 'default',
  inputRef,
  ...input
}: TextFieldProps) {
  const ids = useIds(fieldId);
  return (
    <Frame label={label} hint={hint} error={error} counter={counter} ids={ids}>
      <input
        {...input}
        {...controlProps({ label, hint, error, counter }, ids)}
        ref={inputRef}
        className={cx(styles.control, variant === 'code' && styles.code)}
      />
    </Frame>
  );
}

export interface TextAreaProps
  extends
    FrameProps,
    Omit<TextareaHTMLAttributes<HTMLTextAreaElement>, 'id' | 'className' | 'aria-invalid'> {
  inputRef?: Ref<HTMLTextAreaElement>;
}

export function TextArea({
  label,
  hint,
  error,
  counter,
  fieldId,
  inputRef,
  ...input
}: TextAreaProps) {
  const ids = useIds(fieldId);
  return (
    <Frame label={label} hint={hint} error={error} counter={counter} ids={ids}>
      <textarea
        {...input}
        {...controlProps({ label, hint, error, counter }, ids)}
        ref={inputRef}
        className={cx(styles.control, styles.area)}
      />
    </Frame>
  );
}
