import type { ReactNode } from 'react';
import { useHostAuth } from '../../auth/useHostAuth.ts';
import type { HostAuth } from '../../auth/session.ts';
import { HostShell } from '../../ui/HostShell.tsx';
import { StatusLine } from '../../ui/StatusLine.tsx';
import { LoginScreen } from './LoginScreen.tsx';

export interface HostContext {
  auth: HostAuth;
  displayName: string | null;
}

/**
 * Everything under /host, /present and /edit needs a signed-in host. Signed out, this shows the
 * sign-in for the deployment's auth mode, and remembers the page to come back to.
 */
export function HostGate({ children }: { children: (ctx: HostContext) => ReactNode }) {
  const { auth, snapshot } = useHostAuth();

  if (snapshot.status === 'loading') {
    return (
      <HostShell>
        <h1>Checking your sign-in…</h1>
        <StatusLine visible={false}>Checking your sign-in</StatusLine>
      </HostShell>
    );
  }
  if (snapshot.status === 'signed-out') {
    return (
      <LoginScreen
        mode={auth.mode}
        busy={snapshot.busy}
        error={snapshot.error}
        onLocalSubmit={(u, p) => void auth.signInLocal(u, p)}
        onCognito={() => void auth.signInCognito(window.location.pathname + window.location.search)}
      />
    );
  }
  return <>{children({ auth, displayName: snapshot.displayName })}</>;
}
