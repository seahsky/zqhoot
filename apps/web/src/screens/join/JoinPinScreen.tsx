import type { FormEvent, Ref } from 'react';
import { Button, ButtonLink } from '../../ui/Button.tsx';
import { PhoneShell } from '../../ui/PhoneShell.tsx';
import { TextField } from '../../ui/TextField.tsx';
import styles from './Join.module.css';

export interface JoinPinScreenProps {
  pin: string;
  onPinChange: (pin: string) => void;
  onSubmit: () => void;
  /** Inline, announced, and focus returns to the field. */
  error?: string | null;
  busy?: boolean;
  inputRef?: Ref<HTMLInputElement>;
}

export function JoinPinScreen({
  pin,
  onPinChange,
  onSubmit,
  error,
  busy,
  inputRef,
}: JoinPinScreenProps) {
  const submit = (e: FormEvent) => {
    e.preventDefault();
    onSubmit();
  };
  return (
    <PhoneShell>
      <form className={styles.form} onSubmit={submit} noValidate>
        <h1>Enter the game PIN</h1>
        <TextField
          label="Game PIN"
          hint="The 6 digits on the big screen."
          error={error}
          inputRef={inputRef}
          variant="code"
          name="pin"
          value={pin}
          onChange={(e) => onPinChange(e.target.value)}
          inputMode="numeric"
          pattern="[0-9]*"
          // No maxLength: a pasted "123 456" would be cut to five digits before spaces are
          // filtered out. `onPinChange` keeps the first six digits instead.
          autoComplete="off"
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
          enterKeyHint="go"
        />
        <div className={styles.actions}>
          <Button type="submit" block disabled={busy} aria-busy={busy || undefined}>
            {busy ? 'Checking…' : 'Continue'}
          </Button>
          <ButtonLink to="/" variant="secondary" block>
            Back
          </ButtonLink>
        </div>
      </form>
    </PhoneShell>
  );
}
