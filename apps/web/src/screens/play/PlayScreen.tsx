import { useEffect, useRef } from 'react';
import type { AnswerPayload } from '@zqhoot/protocol';
import type { PlayerState } from '../../state/player.ts';
import { PhoneShell } from '../../ui/PhoneShell.tsx';
import { StatusLine } from '../../ui/StatusLine.tsx';
import { Ended } from './Ended.tsx';
import { Kicked, OutOfDate, SessionOver } from './Farewell.tsx';
import { GetReady } from './GetReady.tsx';
import { Leaderboard } from './Leaderboard.tsx';
import { Lobby } from './Lobby.tsx';
import { PlayerHeader } from './PlayerHeader.tsx';
import { QuestionScreen } from './QuestionScreen.tsx';
import { Reveal } from './Reveal.tsx';
import { TimesUp } from './TimesUp.tsx';
import { announcementFor } from './announce.ts';
import styles from './play.module.css';

export interface PlayScreenProps {
  state: PlayerState;
  /**
   * `index` is the zero-based question the payload answers. Returns whether the answer was
   * handed to the socket (false when it is down), so a text entry can stay in its field.
   */
  onAnswer: (index: number, payload: AnswerPayload) => boolean;
  onLeave: () => void;
  onReload: () => void;
}

function CurrentScreen({ state, onAnswer, onLeave, onReload }: PlayScreenProps) {
  const { view } = state;
  switch (view.screen) {
    case 'connecting':
      return (
        <div className={`${styles.stack} ${styles.centered}`}>
          <h1 className={styles.title}>Connecting…</h1>
          <p className={`${styles.lead} ${styles.muted}`}>Finding your game.</p>
        </div>
      );
    case 'lobby':
      return <Lobby quizTitle={state.quizTitle} onLeave={onLeave} />;
    case 'get-ready':
      return <GetReady view={view} />;
    case 'answering':
    case 'submitted':
      return <QuestionScreen view={view} onAnswer={(payload) => onAnswer(view.q.index, payload)} />;
    case 'times-up':
      return <TimesUp view={view} />;
    case 'reveal':
      return <Reveal view={view} />;
    case 'leaderboard':
      return <Leaderboard view={view} />;
    case 'ended':
      return <Ended view={view} meId={state.me?.playerId} />;
    case 'kicked':
      return <Kicked />;
    case 'session-over':
      return <SessionOver view={view} />;
    case 'out-of-date':
      return <OutOfDate onReload={onReload} />;
  }
}

/** Every player state in one frame: header strip, a persistent live region, then the screen. */
export function PlayScreen(props: PlayScreenProps) {
  const { state } = props;

  // A tapped option unmounts, which would drop keyboard focus to the start of the page.
  const first = useRef(true);
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    const active = document.activeElement;
    if (!active || active === document.body || !document.contains(active)) {
      document.getElementById('main')?.focus({ preventScroll: true });
    }
  }, [state.view.screen]);

  return (
    <PhoneShell wide header={<PlayerHeader me={state.me} connection={state.connection} />}>
      <StatusLine visible={false}>{announcementFor(state.view)}</StatusLine>
      <CurrentScreen {...props} />
    </PhoneShell>
  );
}
