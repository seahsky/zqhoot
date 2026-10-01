import type { PlayerView } from '../../state/player.ts';
import { StatusLine } from '../../ui/StatusLine.tsx';
import styles from './play.module.css';

type TimesUpView = Extract<PlayerView, { screen: 'times-up' }>;

export function TimesUp({ view }: { view: TimesUpView }) {
  const answered = view.responses.length > 0;
  return (
    <>
      <div className={styles.top}>
        <p className={styles.eyebrow}>
          Question {view.q.index + 1} of {view.q.total}
        </p>
        <StatusLine>{view.notice}</StatusLine>
      </div>
      <div className={`${styles.stack} ${styles.centered}`}>
        <h1 className={styles.title}>Time's up</h1>
        <p className={styles.lead}>
          {answered ? 'Your answer is locked in.' : "You didn't answer this one."}
        </p>
        <p className={`${styles.lead} ${styles.muted}`}>The results are on the way.</p>
      </div>
    </>
  );
}
