import type { CSSProperties } from 'react';
import { formatPin, groupDigits } from '../../state/charts.ts';
import type { PresenterView } from '../../state/presenterView.ts';
import { CONTENT_HEIGHT_U, CONTENT_WIDTH_U, nameWall } from './layout.ts';
import s from './Present.module.css';

type LobbyView = Extract<PresenterView, { screen: 'lobby' }>;

const style = (vars: Record<string, string | number>) => vars as CSSProperties;

/** Height the join block takes (title, URL, PIN label and PIN), and the wall heading under it. */
const TOP_U = 30;
const WALL_HEADING_U = 7;

/**
 * The room fills while the host waits: the address and PIN big enough for the back row, a QR
 * code for phones, and every nickname as it arrives (newest first). The wall steps its font
 * down as the room grows and says "+N more" rather than overflowing.
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
  const wallHeightU = CONTENT_HEIGHT_U - (TOP_U + WALL_HEADING_U) * Math.max(1, scale * 0.9) - 6;
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
          <p className={s.pinLabel}>Game PIN</p>
          <p
            className={s.pin}
            data-testid="pin"
            aria-label={`Game PIN ${view.pin.split('').join(' ')}`}
          >
            {formatPin(view.pin)}
          </p>
        </div>
        {qrSrc && <img className={s.qr} src={qrSrc} alt={qrAlt} data-testid="qr" />}
      </div>

      <div className={s.wall}>
        <h2 className={s.wallHeading}>
          <span data-testid="player-count">
            {groupDigits(count)} {count === 1 ? 'player' : 'players'}
          </span>
          {view.locked && <span className={s.lockBadge}>Joining locked</span>}
          <span className={s.wallHint}>Press Space to start</span>
        </h2>
        <ul
          className={s.names}
          aria-label="Players who have joined"
          data-testid="name-wall"
          style={style({
            '--rows': wall.rows,
            '--row-h': `calc(var(--u) * ${wall.rowHeightU.toFixed(2)})`,
            '--col-w': `calc(var(--u) * ${wall.colWidthU.toFixed(2)})`,
            '--fs': wall.fontU,
          })}
        >
          {view.names.slice(0, wall.shown).map((name, i) => (
            <li key={`${i}-${name}`} className={s.name}>
              {name}
            </li>
          ))}
          {wall.more > 0 && (
            <li className={`${s.name} ${s.more}`}>+{groupDigits(wall.more)} more</li>
          )}
        </ul>
      </div>
    </section>
  );
}
