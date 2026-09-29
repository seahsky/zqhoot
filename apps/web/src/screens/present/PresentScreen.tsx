import type { ConnectionStatus } from '../../net/connection.ts';
import type { PresenterView } from '../../state/presenterView.ts';
import { StatusLine } from '../../ui/StatusLine.tsx';
import { Stage } from '../../ui/Stage.tsx';
import type { TextScale } from '../../ui/Stage.tsx';
import {
  ConnectingScreen,
  LeaderboardView,
  OverScreen,
  PodiumScreen,
  ThanksScreen,
} from './Boards.tsx';
import { ControlBar } from './ControlBar.tsx';
import type { ControlBarProps } from './ControlBar.tsx';
import { HelpOverlay } from './HelpOverlay.tsx';
import { LobbyView } from './Lobby.tsx';
import { QuestionView } from './Question.tsx';
import { RevealScreen } from './Reveal.tsx';
import { announcementFor } from './announce.ts';
import s from './Present.module.css';

export interface PresentScreenProps {
  view: PresenterView;
  /** Shown as text under "Join at". */
  joinUrl: string;
  /** `data:image/svg+xml` URL of the QR code for `{joinUrl}?pin={pin}`; null while it is made. */
  qrSrc: string | null;
  qrAlt: string;
  /** The question's picture, already resolved against the media base URL. */
  imageUrl: string | null;
  textScale: TextScale;
  connection: ConnectionStatus;
  /** False under prefers-reduced-motion: rows then stay where they are. */
  animate: boolean;
  /** playerId -> row on the previous leaderboard, for the movement animation. */
  previousRanks?: ReadonlyMap<string, number>;
  wallPage: number;
  onWallPage: (page: number) => void;
  helpOpen: boolean;
  onHelpClose: () => void;
  bar: ControlBarProps;
  onReload: () => void;
}

function Current(p: PresentScreenProps) {
  const { view } = p;
  switch (view.screen) {
    case 'connecting':
      return <ConnectingScreen />;
    case 'lobby':
      return (
        <LobbyView
          view={view}
          joinUrl={p.joinUrl}
          qrSrc={p.qrSrc}
          qrAlt={p.qrAlt}
          scale={p.textScale}
        />
      );
    case 'get-ready':
    case 'question':
    case 'closing':
      return (
        <QuestionView
          view={view}
          imageUrl={p.imageUrl}
          scale={p.textScale}
          wallPage={p.wallPage}
          onWallPage={p.onWallPage}
        />
      );
    case 'reveal':
      return (
        <RevealScreen
          view={view}
          scale={p.textScale}
          wallPage={p.wallPage}
          onWallPage={p.onWallPage}
        />
      );
    case 'leaderboard':
      return <LeaderboardView view={view} previous={p.previousRanks} animate={p.animate} />;
    case 'podium':
      return <PodiumScreen view={view} />;
    case 'thanks':
      return <ThanksScreen view={view} />;
    case 'over':
      return <OverScreen reason={view.reason} onReload={p.onReload} />;
  }
}

/**
 * The projector view: a 16:9 stage with the screen for the current phase, and the control bar
 * beside it. Presentational: everything comes in as props (view model from
 * `state/presenterView.ts`), nothing touches the network.
 */
export function PresentScreen(p: PresentScreenProps) {
  const reconnecting = p.connection === 'reconnecting' || p.connection === 'connecting';
  return (
    <>
      <Stage textScale={p.textScale}>
        <div className={s.pillWrap}>
          <main id="main" tabIndex={-1} className={s.main}>
            <StatusLine visible={false}>{announcementFor(p.view)}</StatusLine>
            <Current {...p} />
          </main>
          <p role="status" className={s.pill}>
            {reconnecting ? 'Reconnecting…' : ''}
          </p>
        </div>
        <HelpOverlay open={p.helpOpen} onClose={p.onHelpClose} />
      </Stage>
      <ControlBar {...p.bar} />
    </>
  );
}
