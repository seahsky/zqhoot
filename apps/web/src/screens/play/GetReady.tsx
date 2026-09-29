import type { AnswerPayload } from '@zqhoot/protocol';
import type { PlayerView } from '../../state/player.ts';
import { AnswerInput } from './AnswerInput.tsx';
import { QuestionHeader } from './QuestionHeader.tsx';
import styles from './play.module.css';
import getReady from './GetReady.module.css';

type GetReadyView = Extract<PlayerView, { screen: 'get-ready' }>;

/** Nothing can be sent yet, so nothing is. */
const NOT_SENT = (_: AnswerPayload) => false;

/** The question is up but options stay inert until `openAt`, so nobody gets a head start. */
export function GetReady({ view }: { view: GetReadyView }) {
  return (
    <>
      <div className={styles.top}>
        <QuestionHeader q={view.q} />
        <p className={getReady.countIn}>
          Get ready: options open in{' '}
          <span className={getReady.numeral}>{view.secondsUntilOpen}</span>
        </p>
      </div>
      <div className={styles.answers}>
        <AnswerInput question={view.q.question} onAnswer={NOT_SENT} disabled />
      </div>
    </>
  );
}
