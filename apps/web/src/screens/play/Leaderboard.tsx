import { pointsLabel, standingSentence } from '../../state/format.ts';
import type { PlayerView } from '../../state/player.ts';
import styles from './play.module.css';

type LeaderboardView = Extract<PlayerView, { screen: 'leaderboard' }>;

/** The phone shows the player's own standing; the top of the table is on the big screen. */
export function Leaderboard({ view }: { view: LeaderboardView }) {
  return (
    <>
      <p className={styles.eyebrow}>
        Round results, question {view.index + 1} of {view.total}
      </p>
      <div className={`${styles.stack} ${styles.centered}`}>
        <h1 className={styles.title}>{standingSentence(view.standing)}</h1>
        <p className={styles.stat}>
          <span>{pointsLabel(view.standing.score)}</span>
        </p>
        <p className={`${styles.lead} ${styles.muted}`}>Next question coming up.</p>
      </div>
    </>
  );
}
