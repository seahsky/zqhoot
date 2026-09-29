import type { FormEvent, Ref } from 'react';
import { LIMITS } from '@zqhoot/protocol';
import { Button } from '../../ui/Button.tsx';
import { PhoneShell } from '../../ui/PhoneShell.tsx';
import { TextField } from '../../ui/TextField.tsx';
import { nicknameCounter } from './nickname.ts';
import styles from './Join.module.css';

export interface JoinNicknameScreenProps {
  quizTitle: string;
  nickname: string;
  onNicknameChange: (nickname: string) => void;
  onSubmit: () => void;
  /** Go back to the PIN step. */
  onBack: () => void;
  error?: string | null;
  busy?: boolean;
  inputRef?: Ref<HTMLInputElement>;
}

export function JoinNicknameScreen({
  quizTitle,
  nickname,
  onNicknameChange,
  onSubmit,
  onBack,
  error,
  busy,
  inputRef,
}: JoinNicknameScreenProps) {
  const submit = (e: FormEvent) => {
    e.preventDefault();
    onSubmit();
  };
  return (
    <PhoneShell>
      <form className={styles.form} onSubmit={submit} noValidate>
        <div className={styles.heading}>
          <p className={styles.eyebrow}>{quizTitle}</p>
          <h1>Pick a nickname</h1>
        </div>
        <TextField
          label="Nickname"
          hint={`${LIMITS.nicknameMinGraphemes} to ${LIMITS.nicknameMaxGraphemes} characters. Everyone in the game can see it.`}
          counter={nicknameCounter(nickname)}
          error={error}
          inputRef={inputRef}
          name="nickname"
          value={nickname}
          onChange={(e) => onNicknameChange(e.target.value)}
          maxLength={LIMITS.nicknameRawMaxLength}
          autoComplete="nickname"
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
          enterKeyHint="go"
        />
        <div className={styles.actions}>
          <Button type="submit" block disabled={busy} aria-busy={busy || undefined}>
            {busy ? 'Joining…' : 'Join'}
          </Button>
          <Button variant="secondary" block onClick={onBack} disabled={busy}>
            Use a different PIN
          </Button>
        </div>
      </form>
    </PhoneShell>
  );
}
