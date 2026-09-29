import type { CSSProperties } from 'react';
import { formatPin, groupDigits } from '../../state/charts.ts';
import type { PresenterView } from '../../state/presenterView.ts';
import { CONTENT_WIDTH_U, lobbyWallHeightU, nameWall } from './layout.ts';
import s from './Present.module.css';

type LobbyView = Extract<PresenterView, { screen: 'lobby' }>;

const style = (vars: Record<string, string | number>) => vars as CSSProperties;

/**
 * The room fills while the host waits: the address and PIN big enough for the back row, a QR
 * code for phones, and every nickname as it arrives (newest first). The names take the space
 * under the join block, at the largest size at which all of them fit (5u down to 3.5u, so
 * hundreds stay readable); only when even that overflows does the oldest end in "+N more".
 */
export function LobbyView({
  view,
  joinUrl,
  qrSrc,
  qrAlt,
  scale,
}: {
  view: LobbyView;
  joinUrl: string;
  qrSrc: string | null;
  qrAlt: string;
  scale: number;
}) {
  const wallHeightU = lobbyWallHeightU({
    title: view.quizTitle,
    joinUrl,
    scale,
    hasQr: qrSrc !== null,
    locked: view.locked,
  });
  const wall = nameWall(view.names, CONTENT_WIDTH_U, wallHeightU);
  const count = view.names.length;

  return (
    <section className={s.screen} aria-labelledby="lobby-title">
      <div className={s.lobbyTop}>
        <div className={s.joinBlock}>
          <h1 id="lobby-title" className={s.quizTitle}>
            {view.quizTitle}
          </h1>
          <p className={s.joinLine}>
            Join at <strong data-testid="join-url">{joinUrl}</strong>
          </p>
          <div className={s.pinRow}>
            <div>
              <p className={s.pinLabel}>PIN</p>
              <p
                className={s.pin}
                data-testid="pin"
                aria-label={`PIN ${view.pin.split('').join(' ')}`}
              >
                {formatPin(view.pin)}
              </p>
            </div>
            <h2 className={s.roomStatus}>
              <span className={s.roomCount} data-testid="player-count">
                {groupDigits(count)} {count === 1 ? 'player' : 'players'}
              </span>
              {view.locked && <span className={s.lockBadge}>Joining locked</span>}
              <span className={s.wallHint}>Press Space to start</span>
            </h2>
          </div>
        </div>
        {qrSrc && <img className={s.qr} src={qrSrc} alt={qrAlt} data-testid="qr" />}
      </div>

      <ul
        className={s.names}
        aria-label="Players who have joined"
        data-testid="name-wall"
        style={style({
          '--fs': wall.fontU,
          '--row-h': `calc(var(--u) * ${wall.rowHeightU.toFixed(3)})`,
          '--pad-x': `calc(var(--u) * ${wall.padXU.toFixed(3)})`,
          '--gap-x': `calc(var(--u) * ${wall.gapXU.toFixed(3)})`,
          '--gap-y': `calc(var(--u) * ${wall.gapYU.toFixed(3)})`,
        })}
      >
        {view.names.slice(0, wall.shown).map((name, i) => (
          <li key={`${i}-${name}`} className={s.name}>
            {name}
          </li>
        ))}
        {wall.more > 0 && <li className={`${s.name} ${s.more}`}>+{groupDigits(wall.more)} more</li>}
      </ul>
    </section>
  );
}
