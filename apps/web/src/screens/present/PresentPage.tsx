import { useEffect, useMemo, useRef, useState } from 'react';
import { Id } from '@zqhoot/protocol';
import { useRoute } from '../../app/router.tsx';
import { usePageTitle } from '../../app/usePageTitle.ts';
import type { HostAuth } from '../../auth/session.ts';
import { getRuntimeConfig } from '../../config/runtime.ts';
import { mediaUrl } from '../../net/upload.ts';
import { createWakeLock } from '../../net/wakeLock.ts';
import { joinLink } from '../../state/charts.ts';
import { closeCommand, lockCommand, nextAction } from '../../state/commands.ts';
import { presenterView } from '../../state/presenterView.ts';
import { ButtonLink } from '../../ui/Button.tsx';
import { HostShell } from '../../ui/HostShell.tsx';
import { TEXT_SCALES } from '../../ui/Stage.tsx';
import type { TextScale } from '../../ui/Stage.tsx';
import { HostGate } from '../host/HostGate.tsx';
import { useHostSession } from '../host/useHostSession.ts';
import { PresentScreen } from './PresentScreen.tsx';
import { useFullscreen, usePersistentChoice, useReducedMotion, useStageTheme } from './hooks.ts';
import { barStateFor } from './controls.ts';
import { presenterKeyAction } from './keys.ts';
import { qrDataUrl } from './qr.ts';

/** The projector view of a session: `/present?s={sessionId}`. */
export function PresentPage() {
  const route = useRoute();
  usePageTitle('Presenter · zqhoot');
  // A malformed id could never say hello, so it is treated like a missing one.
  const raw = route.query.get('s');
  const sessionId = raw !== null && Id.safeParse(raw).success ? raw : null;
  return (
    <HostGate>
      {({ auth }) =>
        sessionId ? (
          <PresentSession key={sessionId} sessionId={sessionId} auth={auth} />
        ) : (
          <HostShell>
            <h1>No session to show</h1>
            <p>Open the presenter from a session on your dashboard.</p>
            <ButtonLink to="/host">Go to the dashboard</ButtonLink>
          </HostShell>
        )
      }
    </HostGate>
  );
}

/** How often the countdown re-reads the server clock; numerals change once a second. */
const CLOCK_TICK_MS = 200;

function PresentSession({ sessionId, auth }: { sessionId: string; auth: HostAuth }) {
  const config = getRuntimeConfig();
  const session = useHostSession({ sessionId, client: 'present', auth, drive: true });
  const { state } = session;
  const snap = state.snapshot;

  const { serverNow } = session;
  const [now, setNow] = useState(() => serverNow());
  useEffect(() => {
    const id = setInterval(() => setNow(serverNow()), CLOCK_TICK_MS);
    return () => clearInterval(id);
  }, [serverNow]);

  const view = presenterView(state, now);

  const [scale, setScale] = usePersistentChoice<TextScale>(
    'zqhoot:present:text-scale',
    TEXT_SCALES,
    1,
  );
  const theme = useStageTheme();
  const fullscreen = useFullscreen();
  const reduced = useReducedMotion();
  const [hiddenChoice, setHiddenChoice] = usePersistentChoice<'yes' | 'no'>(
    'zqhoot:present:controls-hidden',
    ['yes', 'no'],
    'no',
  );
  const [help, setHelp] = useState(false);

  // Paging through open-ended responses starts again on every new screen.
  const [wallPage, setWallPage] = useState(0);
  const screenKey = `${view.screen}:${snap?.questionIndex ?? -1}`;
  useEffect(() => setWallPage(0), [screenKey]);

  // The projector must not sleep mid-quiz.
  useEffect(() => {
    const lock = createWakeLock();
    lock.acquire();
    return () => lock.release();
  }, []);

  // --- commands ----------------------------------------------------------------------------

  const next = snap ? nextAction(snap) : null;
  const doNext = () => {
    if (next?.command) session.send(next.command, next.label);
  };
  const doClose = () => {
    const cmd = snap ? closeCommand(snap) : null;
    if (cmd) session.send(cmd, 'End question');
  };
  const doLock = () => {
    // The button is gone once the game has ended, and so is its key.
    if (snap && barStateFor(snap).canLock)
      session.send(lockCommand(!snap.locked), snap.locked ? 'Unlock joining' : 'Lock joining');
  };
  const cycleScale = () =>
    setScale(TEXT_SCALES[(TEXT_SCALES.indexOf(scale) + 1) % TEXT_SCALES.length] ?? 1);

  // One listener that always sees the latest handlers.
  const handlers = useRef({
    doNext,
    doClose,
    doLock,
    cycleScale,
    toggleFullscreen: fullscreen.toggle,
    toggleTheme: theme.toggle,
  });
  handlers.current = {
    doNext,
    doClose,
    doLock,
    cycleScale,
    toggleFullscreen: fullscreen.toggle,
    toggleTheme: theme.toggle,
  };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const action = presenterKeyAction(
        {
          key: e.key,
          ctrlKey: e.ctrlKey,
          metaKey: e.metaKey,
          altKey: e.altKey,
          target: e.target instanceof HTMLElement ? e.target : null,
        },
        help,
      );
      if (action === null) return;
      // Space and Page Down would scroll; the stage does not, but the page might be zoomed.
      e.preventDefault();
      switch (action) {
        case 'next':
          return handlers.current.doNext();
        case 'close':
          return handlers.current.doClose();
        case 'fullscreen':
          return handlers.current.toggleFullscreen();
        case 'text-size':
          return handlers.current.cycleScale();
        case 'theme':
          return handlers.current.toggleTheme();
        case 'lock':
          return handlers.current.doLock();
        case 'help':
          return setHelp((open) => !open);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [help]);

  // --- leaderboard movement ----------------------------------------------------------------

  const boards = useRef<Array<{ sv: number; ranks: Map<string, number> }>>([]);
  const previousRanks = useMemo(() => {
    if (view.screen !== 'leaderboard' || !snap) return undefined;
    const last = boards.current.at(-1);
    if (last?.sv === snap.sv) return boards.current.at(-2)?.ranks;
    boards.current.push({
      sv: snap.sv,
      ranks: new Map(view.entries.map((e, i) => [e.playerId, i])),
    });
    return last?.ranks;
    // The board is the same until the session version moves on.
  }, [view.screen, snap?.sv]);

  // --- join details ------------------------------------------------------------------------

  const link = snap ? joinLink(config.joinUrl, snap.pin) : config.joinUrl;
  // The code depends on the PIN alone; every `host.state` makes a new snapshot object.
  const haveSnapshot = snap !== null;
  const qrSrc = useMemo(() => (haveSnapshot ? qrDataUrl(link) : null), [link, haveSnapshot]);
  const imageKey = snap?.question?.question.imageKey;

  return (
    <PresentScreen
      view={view}
      joinUrl={config.joinUrl}
      qrSrc={qrSrc}
      qrAlt={`QR code that opens ${link}`}
      imageUrl={imageKey ? mediaUrl(config.mediaBaseUrl, imageKey) : null}
      textScale={scale}
      connection={state.connection}
      animate={!reduced}
      previousRanks={previousRanks}
      wallPage={wallPage}
      onWallPage={setWallPage}
      helpOpen={help}
      onHelpClose={() => setHelp(false)}
      onReload={() => window.location.reload()}
      onSignOut={() => auth.signOut()}
      bar={{
        ...barStateFor(snap),
        textScale: scale,
        dark: theme.dark,
        fullscreen: fullscreen.active,
        hidden: hiddenChoice === 'yes',
        onNext: doNext,
        onClose: doClose,
        onLock: doLock,
        onTextSize: cycleScale,
        onTheme: theme.toggle,
        onFullscreen: fullscreen.toggle,
        onHelp: () => setHelp(true),
        onToggleHidden: () => setHiddenChoice(hiddenChoice === 'yes' ? 'no' : 'yes'),
      }}
    />
  );
}
