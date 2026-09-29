import { useId } from 'react';
import type { ReactNode } from 'react';
import fieldStyles from './TextField.module.css';
import styles from './Controls.module.css';

/**
 * Select, checkbox and radio group for the editor, with the same label, hint and inline error
 * as `TextField`. `fieldId` fixes the DOM id so the error summary can link to the control.
 */

interface Common {
  fieldId?: string;
  label: string;
  hint?: string;
  error?: string | null;
}

function ErrorLine({ id, error }: { id: string; error: string }) {
  return (
    <p id={id} role="alert" className={fieldStyles.error}>
      <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true" focusable="false">
        <path d="M12 3 22 21H2Z" className={fieldStyles.errorIcon} />
        <path d="M12 10v5M12 17.5v.5" className={fieldStyles.errorMark} />
      </svg>
      <span>{error}</span>
    </p>
  );
}

function describedBy(...ids: Array<string | false | undefined | null>): string | undefined {
  const list = ids.filter(Boolean);
  return list.length > 0 ? list.join(' ') : undefined;
}

export interface SelectOption {
  value: string;
  label: string;
}

export function SelectField({
  fieldId,
  label,
  hint,
  error,
  value,
  options,
  onChange,
  disabled,
}: Common & {
  value: string;
  options: readonly SelectOption[];
  onChange: (value: string) => void;
  disabled?: boolean;
}) {
  const uid = useId();
  const id = fieldId ?? `${uid}-select`;
  const hintId = `${id}-hint`;
  const errorId = `${id}-error`;
  return (
    <div className={fieldStyles.field}>
      <label htmlFor={id} className={fieldStyles.label}>
        {label}
      </label>
      {hint && (
        <p id={hintId} className={fieldStyles.hint}>
          {hint}
        </p>
      )}
      <div className={styles.selectWrap}>
        <select
          id={id}
          className={styles.select}
          value={value}
          disabled={disabled}
          aria-invalid={error ? true : undefined}
          aria-describedby={describedBy(hint && hintId, error && errorId)}
          onChange={(e) => onChange(e.target.value)}
        >
          {options.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      </div>
      {error && <ErrorLine id={errorId} error={error} />}
    </div>
  );
}

export function CheckboxField({
  fieldId,
  label,
  hint,
  error,
  checked,
  onChange,
}: Common & { checked: boolean; onChange: (checked: boolean) => void }) {
  const uid = useId();
  const id = fieldId ?? `${uid}-checkbox`;
  const hintId = `${id}-hint`;
  const errorId = `${id}-error`;
  return (
    <div className={fieldStyles.field}>
      <div className={styles.checkRow}>
        <input
          id={id}
          type="checkbox"
          className={styles.checkbox}
          checked={checked}
          aria-invalid={error ? true : undefined}
          aria-describedby={describedBy(hint && hintId, error && errorId)}
          onChange={(e) => onChange(e.target.checked)}
        />
        <label htmlFor={id} className={styles.checkLabel}>
          {label}
        </label>
      </div>
      {hint && (
        <p id={hintId} className={`${fieldStyles.hint} ${styles.checkHint}`}>
          {hint}
        </p>
      )}
      {error && <ErrorLine id={errorId} error={error} />}
    </div>
  );
}

export interface RadioOption {
  value: string;
  label: string;
  /** Extra content beside the label, e.g. the answer's glyph. */
  adornment?: ReactNode;
}

export function RadioGroup({
  fieldId,
  legend,
  hint,
  error,
  name,
  value,
  options,
  onChange,
  inline,
}: Omit<Common, 'label'> & {
  legend: string;
  name: string;
  value: string;
  options: readonly RadioOption[];
  onChange: (value: string) => void;
  /** Lay the choices out in one row when there is room. */
  inline?: boolean;
}) {
  const uid = useId();
  const id = fieldId ?? `${uid}-radios`;
  const hintId = `${id}-hint`;
  const errorId = `${id}-error`;
  return (
    <fieldset
      id={id}
      className={styles.group}
      aria-describedby={describedBy(hint && hintId, error && errorId)}
    >
      <legend className={fieldStyles.label}>{legend}</legend>
      {hint && (
        <p id={hintId} className={fieldStyles.hint}>
          {hint}
        </p>
      )}
      <div className={inline ? styles.radiosInline : styles.radios}>
        {options.map((o) => {
          const inputId = `${id}-${o.value}`;
          return (
            <div key={o.value} className={styles.radioRow}>
              <input
                id={inputId}
                type="radio"
                name={name}
                className={styles.radio}
                value={o.value}
                checked={value === o.value}
                onChange={() => onChange(o.value)}
              />
              <label htmlFor={inputId} className={styles.radioLabel}>
                {o.adornment}
                {o.label}
              </label>
            </div>
          );
        })}
      </div>
      {error && <ErrorLine id={errorId} error={error} />}
    </fieldset>
  );
}
