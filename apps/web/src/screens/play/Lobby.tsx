import { Button } from '../../ui/Button.tsx';
import styles from './play.module.css';

export function Lobby({ quizTitle, onLeave }: { quizTitle: string; onLeave: () => void }) {
  return (
    <>
      <div className={`${styles.stack} ${styles.centered}`}>
        {quizTitle && <p className={styles.eyebrow}>{quizTitle}</p>}
        <h1 className={styles.title}>You're in. Watch the big screen.</h1>
        <p className={`${styles.lead} ${styles.muted}`}>
          The first question will show up here when the host starts the game.
        </p>
      </div>
      <div className={styles.actions}>
        <Button variant="secondary" block onClick={onLeave}>
          Leave game
        </Button>
      </div>
    </>
  );
}
