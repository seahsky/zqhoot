import { formatNumber, ordinal } from '../../state/format.ts';
import type { PlayerView } from '../../state/player.ts';
import { ButtonLink } from '../../ui/Button.tsx';
import { cx } from '../../ui/cx.ts';
import { StatCard } from './StatCard.tsx';
import { scoreFigure } from './figures.ts';
import type { Figure } from './figures.ts';
import styles from './play.module.css';

type EndedView = Extract<PlayerView, { screen: 'ended' }>;

/** `meId` marks the player's own row in the list; without it no row is marked. */
export function Ended({ view, meId }: { view: EndedView; meId?: string }) {
  const { standing, podium } = view;
  const figures: Figure[] = [scoreFigure(standing.score)];
  if (standing.scoredQuestions > 0) {
    figures.push({
      value: `${standing.correct} of ${standing.scoredQuestions}`,
      label: 'correct',
    });
  }
  return (
    <>
      <p className={styles.eyebrow}>Final results</p>
      <div className={`${styles.stack} ${styles.centered}`}>
        <h1 className={styles.title}>
          {standing.rank === null ? 'Thanks for playing' : `You finished ${ordinal(standing.rank)}`}
        </h1>
        <StatCard figures={figures} />

        {podium.length > 0 && (
          <div className={styles.stack}>
            <h2 className={styles.lead}>Top players</h2>
            <ol className={styles.list}>
              {podium.map((entry) => {
                const mine = meId !== undefined && entry.playerId === meId;
                return (
                  <li
                    key={entry.playerId}
                    className={cx(styles.row, mine && styles.mine)}
                    aria-current={mine || undefined}
                  >
                    <span className={styles.rank}>{ordinal(entry.rank)}</span>
                    <span className={styles.grow}>
                      {entry.nickname} {mine && <span className={styles.you}>You</span>}
                    </span>
                    <span className={`${styles.end} tabular`}>{formatNumber(entry.score)}</span>
                  </li>
                );
              })}
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
