import { Id } from '@zqhoot/protocol';
import { usePageTitle } from '../../app/usePageTitle.ts';
import type { HostAuth } from '../../auth/session.ts';
import { getRuntimeConfig } from '../../config/runtime.ts';
import {
  endCommand,
  kickCommand,
  lockCommand,
  moderateCommand,
  nextAction,
  skipCommand,
} from '../../state/commands.ts';
import { ButtonLink } from '../../ui/Button.tsx';
import { HostShell } from '../../ui/HostShell.tsx';
import { openPresenter } from './DashboardPage.tsx';
import { LiveScreen } from './LiveScreen.tsx';
import { useHostSession } from './useHostSession.ts';

/** `/host/live?s={sessionId}`: connects with `host.hello {client:'control'}`. */
export function LivePage({
  auth,
  displayName,
  sessionId,
}: {
  auth: HostAuth;
  displayName: string | null;
  sessionId: string | null;
}) {
  usePageTitle('Live control · zqhoot');
  // A malformed id could never say hello, so it is treated like a missing one.
  if (sessionId === null || !Id.safeParse(sessionId).success) {
    return (
      <HostShell displayName={displayName} onSignOut={() => auth.signOut()}>
        <h1>No session to control</h1>
        <p>Start a session from your dashboard, or open one from the recent sessions.</p>
        <ButtonLink to="/host">Go to the dashboard</ButtonLink>
      </HostShell>
    );
  }
  return (
    <ControlSession key={sessionId} auth={auth} displayName={displayName} sessionId={sessionId} />
  );
}

function ControlSession({
  auth,
  displayName,
  sessionId,
}: {
  auth: HostAuth;
  displayName: string | null;
  sessionId: string;
}) {
  const session = useHostSession({ sessionId, client: 'control', auth, drive: true });
  const { state, send, dispatch } = session;
  const snap = state.snapshot;

  return (
    <LiveScreen
      state={state}
      joinUrl={getRuntimeConfig().joinUrl}
      displayName={displayName}
      onSignOut={() => auth.signOut()}
      onNext={() => {
        const a = snap ? nextAction(snap) : null;
        if (a?.command) send(a.command, a.label);
      }}
      onSkip={() => {
        const cmd = snap ? skipCommand(snap) : null;
        if (cmd) send(cmd, 'Skip question');
      }}
      onEnd={() => void send(endCommand(), 'End session')}
      onLock={(locked) =>
        void send(lockCommand(locked), locked ? 'Lock joining' : 'Unlock joining')
      }
      onKick={(playerId) => void send(kickCommand(playerId), 'Kick player')}
      onModerate={(responseId, status) => {
        const cmd = snap ? moderateCommand(snap, responseId, status) : null;
        // The server sends no ack, so the list changes as soon as the command is on its way.
        if (cmd && send(cmd, status === 'visible' ? 'Show response' : 'Hide response')) {
          dispatch({ type: 'moderated', responseId, status });
        }
      }}
      onOpenPresenter={() => openPresenter(sessionId)}
      onDismissNotice={() => dispatch({ type: 'notice.dismiss' })}
    />
  );
}
