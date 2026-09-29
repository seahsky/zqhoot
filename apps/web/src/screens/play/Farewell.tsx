import type { PlayerView } from '../../state/player.ts';
import { Button, ButtonLink } from '../../ui/Button.tsx';
import styles from './play.module.css';

/** The two dead ends: the host removed you, or the game is gone. */
export function Kicked() {
  return (
    <>
      <div className={`${styles.stack} ${styles.centered}`}>
        <h1 className={styles.title}>The host removed you from this game</h1>
        <p className={`${styles.lead} ${styles.muted}`}>
          You can go back to the start and join a different game.
        </p>
      </div>
      <div className={styles.actions}>
        <ButtonLink to="/" block>
          Back to start
        </ButtonLink>
      </div>
    </>
  );
}

export function SessionOver({ view }: { view: Extract<PlayerView, { screen: 'session-over' }> }) {
  return (
    <>
      <div className={`${styles.stack} ${styles.centered}`}>
        <h1 className={styles.title}>This game has ended</h1>
        <p className={`${styles.lead} ${styles.muted}`}>
          {view.reason === 'not-found'
            ? "We couldn't find this game. It may be over, or the link may be out of date."
            : 'The host closed it. Thanks for playing.'}
        </p>
      </div>
      <div className={styles.actions}>
        <ButtonLink to="/join" block>
          Join another game
        </ButtonLink>
      </div>
    </>
  );
}

/**
 * The server refused this page's protocol version (a bundle cached from before a deploy).
 * The player is still in the game, so a reload resumes it.
 */
export function OutOfDate({ onReload }: { onReload: () => void }) {
  return (
    <>
      <div className={`${styles.stack} ${styles.centered}`}>
        <h1 className={styles.title}>This page is out of date</h1>
        <p className={`${styles.lead} ${styles.muted}`}>
          Reload it to keep playing. You will rejoin the game where you left off.
        </p>
      </div>
      <div className={styles.actions}>
        <Button block onClick={onReload}>
          Reload
        </Button>
      </div>
    </>
  );
}
