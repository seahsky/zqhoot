import { ordinal, pointsLabel, revealHeadline } from '../../state/format.ts';
import type { PlayerView } from '../../state/player.ts';
import { AnswerOption } from '../../ui/AnswerOption.tsx';
import { ResultIcon } from '../../ui/ResultIcon.tsx';
import styles from './play.module.css';
import reveal from './Reveal.module.css';

type RevealView = Extract<PlayerView, { screen: 'reveal' }>;

export function Reveal({ view }: { view: RevealView }) {
  const { outcome, variant, correctAnswer } = view;
  // Poll-style questions carry no points, so there is no score to report.
  const scored = outcome.correct !== undefined;
  return (
    <>
      <p className={styles.eyebrow}>
        Question {view.index + 1} of {view.total}
      </p>
      <div className={`${styles.stack} ${styles.centered}`}>
        <div className={reveal.result}>
          <ResultIcon kind={variant} />
          <h1 className={styles.title}>{revealHeadline(view)}</h1>
        </div>

        {variant === 'correct' && view.gained > 0 && outcome.streakBonus > 0 && (
          <p className={styles.lead}>
            {pointsLabel(outcome.points)} plus {pointsLabel(outcome.streakBonus)} streak bonus
          </p>
        )}
        {outcome.streak >= 2 && <p className={styles.lead}>{outcome.streak} in a row</p>}

        {variant !== 'correct' && correctAnswer && (
          <div className={styles.stack}>
            <p className={styles.eyebrow}>The correct answer was</p>
            <AnswerOption slot={correctAnswer.slot} text={correctAnswer.text} />
          </div>
        )}

        {scored && (
          <p className={styles.stat}>
            <span>{pointsLabel(outcome.score)}</span>
            {outcome.rank !== null && <span>{ordinal(outcome.rank)} place</span>}
          </p>
        )}
      </div>
    </>
  );
}
