import type { ConnectionStatus } from '../../net/connection.ts';
import { formatNumber } from '../../state/format.ts';
import type { PlayerProfile } from '../../state/player.ts';
import { StatusLine } from '../../ui/StatusLine.tsx';
import styles from './PlayerHeader.module.css';

export function connectionText(status: ConnectionStatus): string {
  if (status === 'connecting') return 'Connecting…';
  if (status === 'reconnecting') return 'Reconnecting…';
  return '';
}

/** Nickname, score and connection state. The screen below it never blanks while reconnecting. */
export function PlayerHeader({
  me,
  connection,
}: {
  me: PlayerProfile | null;
  connection: ConnectionStatus;
}) {
  return (
    <div className={styles.header}>
      {me && (
        <div className={styles.strip}>
          <span className={styles.nickname}>{me.nickname}</span>
          <span className={styles.score}>
            <span className="tabular">{formatNumber(me.score)}</span> pts
          </span>
        </div>
      )}
      <StatusLine>{connectionText(connection)}</StatusLine>
    </div>
  );
}
