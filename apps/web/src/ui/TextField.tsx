import { useCallback, useEffect, useId, useRef } from 'react';
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
  /** Decoration before the label text, e.g. an answer's glyph. Hidden from assistive technology. */
  adornment?: ReactNode;
  hint?: string;
  /** Shown inline and announced (`role="alert"`) when it appears. */
  error?: string | null;
  /** Live character count, e.g. "5 / 16". Part of the field's description, not announced per keystroke. */
  counter?: string;
  /**
   * A button beside the input, centred on it. The counter and error stay under the input, so
   * the button never moves down with them. It wraps below the input when the row is narrow.
   */
  action?: ReactNode;
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
  adornment,
  hint,
  error,
  counter,
  action,
  ids,
  children,
}: FrameProps & {
  ids: Ids;
  children: ReactNode;
}) {
  const under = (error || counter) && (
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
  );
  const head = (
    <>
      <label
        htmlFor={ids.control}
        className={cx(styles.label, Boolean(adornment) && styles.labelRow)}
      >
        {adornment}
        {label}
      </label>
      {hint && (
        <p id={ids.hint} className={styles.hint}>
          {hint}
        </p>
      )}
    </>
  );
  if (action) {
    return (
      <div className={styles.actionBox}>
        <div className={cx(styles.withAction, hint && styles.withHint)}>
          {head}
          {children}
          {under}
          <div className={styles.action}>{action}</div>
        </div>
      </div>
    );
  }
  return (
    <div className={styles.field}>
      {head}
      {children}
      {under}
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
  adornment,
  hint,
  error,
  counter,
  action,
  fieldId,
  variant = 'default',
  inputRef,
  ...input
}: TextFieldProps) {
  const ids = useIds(fieldId);
  return (
    <Frame
      label={label}
      adornment={adornment}
      hint={hint}
      error={error}
      counter={counter}
      action={action}
      ids={ids}
    >
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

/** Sets the height that shows all of the text, for browsers without `field-sizing: content`. */
function fitToContent(el: HTMLTextAreaElement) {
  el.style.height = 'auto';
  // The box is border-box and `scrollHeight` leaves out the border (and a scrollbar), so add it:
  // without it the box is short by the border's width twice over and the last line is cut off.
  el.style.height = `${el.scrollHeight + el.offsetHeight - el.clientHeight}px`;
}

/**
 * Browsers without `field-sizing: content` get the same growth from a measured height. It is
 * measured again when the text changes and when the width does (a rotated phone, a resized
 * window), because a narrower box wraps the same text onto more lines.
 */
function useGrowWithContent(value: unknown) {
  const ref = useRef<HTMLTextAreaElement | null>(null);
  const supported = typeof CSS !== 'undefined' && CSS.supports('field-sizing', 'content');
  useEffect(() => {
    const el = ref.current;
    if (el && !supported) fitToContent(el);
  }, [value, supported]);
  useEffect(() => {
    const el = ref.current;
    if (!el || supported || typeof ResizeObserver === 'undefined') return;
    let width = el.offsetWidth;
    const observer = new ResizeObserver(() => {
      // Only a change of width matters; setting the height here must not start a loop.
      if (el.offsetWidth === width) return;
      width = el.offsetWidth;
      fitToContent(el);
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [supported]);
  return ref;
}

export function TextArea({
  label,
  adornment,
  hint,
  error,
  counter,
  action,
  fieldId,
  inputRef,
  ...input
}: TextAreaProps) {
  const ids = useIds(fieldId);
  const grow = useGrowWithContent(input.value);
  // One callback for as long as `inputRef` is the same, so a function ref is not called with
  // null and then the element again on every render.
  const setRef = useCallback(
    (el: HTMLTextAreaElement | null) => {
      grow.current = el;
      if (typeof inputRef === 'function') inputRef(el);
      else if (inputRef) inputRef.current = el;
    },
    [grow, inputRef],
  );
  return (
    <Frame
      label={label}
      adornment={adornment}
      hint={hint}
      error={error}
      counter={counter}
      action={action}
      ids={ids}
    >
      <textarea
        {...input}
        {...controlProps({ label, hint, error, counter }, ids)}
        ref={setRef}
        className={cx(styles.control, styles.area)}
      />
    </Frame>
  );
}
