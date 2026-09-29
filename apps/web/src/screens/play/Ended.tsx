import { formatNumber, ordinal, pointsLabel } from '../../state/format.ts';
import type { PlayerView } from '../../state/player.ts';
import { ButtonLink } from '../../ui/Button.tsx';
import styles from './play.module.css';

type EndedView = Extract<PlayerView, { screen: 'ended' }>;

export function Ended({ view }: { view: EndedView }) {
  const { standing, podium } = view;
  return (
    <>
      <p className={styles.eyebrow}>Game over</p>
      <div className={`${styles.stack} ${styles.centered}`}>
        <h1 className={styles.title}>
          {standing.rank === null ? 'Thanks for playing' : `You finished ${ordinal(standing.rank)}`}
        </h1>
        <p className={styles.stat}>
          <span>{pointsLabel(standing.score)}</span>
          {standing.scoredQuestions > 0 && (
            <span>
              {standing.correct} of {standing.scoredQuestions} correct
            </span>
          )}
        </p>

        {podium.length > 0 && (
          <div className={styles.stack}>
            <h2 className={styles.lead}>Top players</h2>
            <ol className={styles.list}>
              {podium.map((entry) => (
                <li key={entry.playerId} className={styles.row}>
                  <span className={styles.rank}>{ordinal(entry.rank)}</span>
                  <span className={styles.grow}>{entry.nickname}</span>
                  <span className={`${styles.end} tabular`}>{formatNumber(entry.score)}</span>
                </li>
              ))}
            </ol>
          </div>
        )}
      </div>
      <div className={styles.actions}>
        <ButtonLink to="/join" block>
          Join another game
        </ButtonLink>
      </div>
    </>
  );
}
