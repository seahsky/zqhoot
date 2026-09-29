import { useCallback, useEffect, useReducer, useRef, useState } from 'react';
import { PROTOCOL_VERSION } from '@zqhoot/protocol';
import type { AnswerPayload } from '@zqhoot/protocol';
import { navigate, useRoute } from '../../app/router.tsx';
import { usePageTitle } from '../../app/usePageTitle.ts';
import { getRuntimeConfig } from '../../config/runtime.ts';
import { Connection } from '../../net/connection.ts';
import { clearCredentials, loadCredentialsOrHeld } from '../../net/credentials.ts';
import type { PlayerCredentials } from '../../net/credentials.ts';
import { createWakeLock } from '../../net/wakeLock.ts';
import { initialPlayerState, playerReducer } from '../../state/player.ts';
import type { PlayerScreen } from '../../state/player.ts';
import { PlayScreen } from './PlayScreen.tsx';

/** How often the countdown re-reads the server clock. Numerals only change once a second. */
const TICK_MS = 200;

/** From the moment the question shows until the answering window is over. */
function isQuestionOpen(screen: PlayerScreen): boolean {
  return screen === 'get-ready' || screen === 'answering' || screen === 'submitted';
}

/** Resumes the game this device is in, or sends the player to `/join`. */
export function PlayPage() {
  const route = useRoute();
  usePageTitle('Playing · zqhoot');
  // Read once per page load: the URL hint only matters for finding the credentials.
  const [creds] = useState(() => loadCredentialsOrHeld(route.query.get('s')));
  useEffect(() => {
    if (!creds) navigate('/join', { replace: true });
  }, [creds]);
  return creds ? <ActiveGame creds={creds} /> : null;
}

function ActiveGame({ creds }: { creds: PlayerCredentials }) {
  const [state, dispatch] = useReducer(playerReducer, 'connecting', initialPlayerState);
  const connection = useRef<Connection | null>(null);
  const { screen } = state.view;
  // The connection outlives renders, so its planned-reconnect check reads the latest screen
  // through a ref.
  const screenRef = useRef(screen);
  useEffect(() => {
    screenRef.current = screen;
  }, [screen]);

  useEffect(() => {
    const conn = new Connection({
      url: getRuntimeConfig().wsUrl,
      hello: () => ({
        type: 'resume',
        v: PROTOCOL_VERSION,
        sessionId: creds.sessionId,
        playerId: creds.playerId,
        token: creds.token,
      }),
      onMessage: (msg) => {
        dispatch({ type: 'message', msg });
        // The token is no good any more (session gone, or it was never valid here).
        if (msg.type === 'error' && (msg.code === 'unauthorized' || msg.code === 'forbidden')) {
          clearCredentials(creds.sessionId);
          conn.stop();
          navigate('/join', { replace: true });
        }
      },
      onStatus: (status) => dispatch({ type: 'connection', status }),
      // ADR-0008: the proactive reconnect belongs between questions, not while one is open.
      canReconnectNow: () => !isQuestionOpen(screenRef.current),
    });
    connection.current = conn;
    conn.start();
    return () => {
      conn.stop();
      connection.current = null;
    };
  }, [creds]);

  useEffect(() => {
    const wakeLock = createWakeLock();
    wakeLock.acquire();
    return () => wakeLock.release();
  }, []);

  // Ended, kicked or session-over: the credentials are useless now (ADR-0008).
  useEffect(() => {
    if (screen === 'ended' || screen === 'kicked' || screen === 'session-over') {
      clearCredentials(creds.sessionId);
      connection.current?.stop();
    }
    // Out of date: reconnecting would be refused again, but the player is still in the game,
    // so the credentials stay and a reload resumes it.
    if (screen === 'out-of-date') connection.current?.stop();
  }, [screen, creds.sessionId]);

  const counting = isQuestionOpen(screen);
  useEffect(() => {
    const conn = connection.current;
    if (!counting || !conn) return;
    const id = setInterval(() => {
      // Until the first message after (re)connecting there is no offset, and the raw
      // local clock could be minutes off the server's.
      if (conn.clock.offsetMs !== null) {
        dispatch({ type: 'tick', now: conn.clock.serverNow(Date.now()) });
      }
    }, TICK_MS);
    return () => clearInterval(id);
  }, [counting]);

  const onAnswer = useCallback((index: number, payload: AnswerPayload): boolean => {
    const sent =
      connection.current?.send({ type: 'answer', questionIndex: index, payload }) ?? false;
    dispatch(sent ? { type: 'answer.sent', index, payload } : { type: 'answer.unsent', index });
    return sent;
  }, []);

  const onReload = useCallback(() => window.location.reload(), []);

  const onLeave = useCallback(() => {
    connection.current?.send({ type: 'leave' });
    clearCredentials(creds.sessionId);
    connection.current?.stop();
    navigate('/', { replace: true });
  }, [creds.sessionId]);

  return <PlayScreen state={state} onAnswer={onAnswer} onLeave={onLeave} onReload={onReload} />;
}
