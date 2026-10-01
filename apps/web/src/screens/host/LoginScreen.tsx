import { useState } from 'react';
import type { FormEvent } from 'react';
import { Button } from '../../ui/Button.tsx';
import { HostShell } from '../../ui/HostShell.tsx';
import { StatusLine } from '../../ui/StatusLine.tsx';
import { TextField } from '../../ui/TextField.tsx';
import styles from './Host.module.css';

export interface LoginScreenProps {
  mode: 'local' | 'cognito';
  busy: boolean;
  /** Why the last attempt failed, or why the host was signed out. */
  error: string | null;
  onLocalSubmit: (username: string, password: string) => void;
  onCognito: () => void;
}

/**
 * Host sign-in. Local: a username and password form that password managers recognise and
 * that accepts pasted text (WCAG 3.3.8). Cognito: one button that hands over to the managed
 * login page, which supports the same.
 */
export function LoginScreen({ mode, busy, error, onLocalSubmit, onCognito }: LoginScreenProps) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const submit = (e: FormEvent) => {
    e.preventDefault();
    onLocalSubmit(username, password);
  };
  return (
    <HostShell>
      <div className={styles.narrow}>
        <h1>Host sign-in</h1>
        {mode === 'local' ? (
          <form className={styles.form} onSubmit={submit} noValidate>
            <TextField
              label="Username"
              name="username"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              autoComplete="username"
              autoCapitalize="off"
              autoCorrect="off"
              spellCheck={false}
            />
            <TextField
              label="Password"
              name="password"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete="current-password"
              error={error}
            />
            <Button type="submit" disabled={busy} aria-busy={busy || undefined}>
              {busy ? 'Signing in…' : 'Sign in'}
            </Button>
          </form>
        ) : (
          <div className={styles.form}>
            <p className={styles.lead}>
              You'll go to the sign-in page, then come straight back here.
            </p>
            {error && (
              <p role="alert" className={styles.problem}>
                {error}
              </p>
            )}
            <Button onClick={onCognito} disabled={busy} aria-busy={busy || undefined}>
              {busy ? 'Opening sign-in…' : 'Sign in'}
            </Button>
          </div>
        )}
        <StatusLine visible={false}>{busy ? 'Signing in' : ''}</StatusLine>
      </div>
    </HostShell>
  );
}
