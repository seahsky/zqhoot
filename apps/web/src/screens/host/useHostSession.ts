import { useCallback, useEffect, useReducer, useRef, useState } from 'react';
import type { Dispatch } from 'react';
import { ClientMessage, PROTOCOL_VERSION } from '@zqhoot/protocol';
import type { HostSnapshot } from '@zqhoot/protocol';
import type { HostAuth } from '../../auth/session.ts';
import { getRuntimeConfig } from '../../config/runtime.ts';
import { Connection } from '../../net/connection.ts';
import { hostReducer, initialHostState } from '../../state/host.ts';
import type { HostAction, HostState } from '../../state/host.ts';
import { IDLE_DRIVER, driverQuestionOf, driverStep } from '../../state/driver.ts';
import type { DriverInput, DriverState } from '../../state/driver.ts';
import { hostMayReconnect } from '../../state/reconnect.ts';

/** How often the driver looks at the clock. Deadlines are seconds long; this is plenty. */
const DRIVER_TICK_MS = 250;

/**
 * Every command is checked against the protocol schema before it leaves, like an HTTP body: a
 * message the server would refuse as `bad-request` (and count against the connection's rate
 * limit) is a bug in the caller, and stays in the browser.
 */
function sendChecked(conn: Connection, msg: ClientMessage): boolean {
  const parsed = ClientMessage.safeParse(msg);
  if (!parsed.success) {
    console.warn('zqhoot: refused to send an invalid message', msg.type, parsed.error.message);
    return false;
  }
  return conn.send(parsed.data);
}

export interface HostSession {
  state: HostState;
  dispatch: Dispatch<HostAction>;
  /** Sends a command; false (and an "offline" notice) when the socket is not open. */
  send: (msg: ClientMessage, what: string) => boolean;
  /** Estimated server time, from the clock the connection keeps (ADR-0005). */
  serverNow: () => number;
}

/**
 * One host WebSocket, control or presenter: `host.hello` with a fresh token on every
 * (re)connect, the reducer that folds every message into `HostState`, and, when `drive` is on,
 * the polling and auto-close machine of `state/driver.ts`.
 */
export function useHostSession(o: {
  sessionId: string;
  client: 'control' | 'present';
  auth: HostAuth;
  drive: boolean;
}): HostSession {
  const { sessionId, client, auth, drive } = o;
  const [state, dispatch] = useReducer(hostReducer, 'connecting', initialHostState);
  const conn = useRef<Connection | null>(null);
  const driver = useRef<DriverState>(IDLE_DRIVER);
  // Bumped after a refreshed sign-in, to open a new connection with the new token.
  const [epoch, setEpoch] = useState(0);
  // The connection outlives renders, so its planned-reconnect check reads the phase through a ref.
  const phaseRef = useRef<HostSnapshot['phase'] | null>(null);

  const serverNow = useCallback(() => conn.current?.clock.serverNow(Date.now()) ?? Date.now(), []);

  const send = useCallback((msg: ClientMessage, what: string): boolean => {
    const sent = conn.current ? sendChecked(conn.current, msg) : false;
    if (!sent) dispatch({ type: 'send.failed', what });
    return sent;
  }, []);

  useEffect(() => {
    const c = new Connection({
      url: getRuntimeConfig().wsUrl,
      hello: () => {
        const authToken = auth.getToken();
        if (!authToken) {
          // Expired while the page was asleep: refresh, then come back with a new connection.
          void auth.handleUnauthorized().then((ok) => ok && setEpoch((n) => n + 1));
          return null;
        }
        const hello = ClientMessage.safeParse({
          type: 'host.hello',
          v: PROTOCOL_VERSION,
          sessionId,
          client,
          authToken,
        });
        return hello.success ? hello.data : null;
      },
      onMessage: (msg) => dispatch({ type: 'message', msg }),
      onStatus: (status) => dispatch({ type: 'connection', status }),
      // ADR-0008: the proactive reconnect belongs between questions, not while one is open.
      canReconnectNow: () => hostMayReconnect(phaseRef.current),
    });
    conn.current = c;
    driver.current = IDLE_DRIVER;
    c.start();
    return () => {
      c.stop();
      conn.current = null;
    };
  }, [sessionId, client, auth, epoch]);

  // A final error ends the conversation; only an expired sign-in can be mended.
  useEffect(() => {
    if (state.ended === null) return;
    conn.current?.stop();
    if (state.ended !== 'unauthorized') return;
    void auth.handleUnauthorized().then((ok) => {
      if (!ok) return;
      dispatch({ type: 'reset', connection: 'connecting' });
      setEpoch((n) => n + 1);
    });
  }, [state.ended, auth]);

  // --- polling and auto-close -------------------------------------------------------------

  const run = useCallback((input: DriverInput) => {
    const c = conn.current;
    if (!c) return;
    const step = (i: DriverInput) => {
      const result = driverStep(driver.current, i, c.clock.serverNow(Date.now()));
      driver.current = result.state;
      for (const cmd of result.commands) {
        // A command the socket refused is remembered as unsent, so a close is tried again.
        if (!sendChecked(c, cmd))
          step({ type: 'unsent', command: cmd.type === 'host.close' ? 'close' : 'stats' });
      }
    };
    step(input);
  }, []);

  const snapshot = state.snapshot;
  useEffect(() => {
    phaseRef.current = snapshot?.phase ?? null;
  }, [snapshot]);
  useEffect(() => {
    if (!drive) return;
    const q = snapshot?.question;
    run({
      type: 'sync',
      question:
        snapshot && snapshot.phase === 'question' && q
          ? driverQuestionOf(q.question, snapshot.questionIndex, q.openAt, q.deadline)
          : null,
    });
  }, [drive, snapshot, run]);

  const stats = state.live?.stats ?? null;
  const liveIndex = state.live?.questionIndex ?? -1;
  useEffect(() => {
    if (!drive || !stats) return;
    run({
      type: 'stats',
      questionIndex: liveIndex,
      answered: stats.answered,
      totalPlayers: stats.totalPlayers,
      cursor: stats.type === 'open' ? stats.cursor : null,
    });
  }, [drive, stats, liveIndex, run]);

  // Every reconnect and every refused moderation re-reads the responses from the first page.
  useEffect(() => {
    if (drive && state.connection === 'open') run({ type: 'resync' });
  }, [drive, state.connection, run]);
  useEffect(() => {
    if (drive && state.moderationFailures > 0) run({ type: 'resync' });
  }, [drive, state.moderationFailures, run]);

  // A close the server refused (rate limit, a hiccup) is sent again after a short wait.
  useEffect(() => {
    if (drive && state.closeRefusals > 0) run({ type: 'close.refused' });
  }, [drive, state.closeRefusals, run]);

  useEffect(() => {
    if (!drive) return;
    const id = setInterval(() => {
      // No offset until the first message: the device clock could be minutes off the server's.
      if (conn.current && conn.current.clock.offsetMs !== null) run({ type: 'tick' });
    }, DRIVER_TICK_MS);
    return () => clearInterval(id);
  }, [drive, run]);

  return { state, dispatch, send, serverNow };
}
