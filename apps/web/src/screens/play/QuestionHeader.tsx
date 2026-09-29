import type { PublicQuestion } from '@zqhoot/protocol';
import type { QuestionInfo } from '../../state/player.ts';
import styles from './play.module.css';

/** Used when the quiz hides question text on phones (`showQuestionOnDevices: false`). */
const FALLBACK_HEADING: Record<PublicQuestion['type'], string> = {
  single: 'Pick an answer',
  truefalse: 'True or false?',
  poll: 'Pick an option',
  wordcloud: 'Send your words',
  open: 'Write your response',
  rating: 'Give a rating',
};

export function promptOf(q: QuestionInfo): string {
  return q.question.prompt || FALLBACK_HEADING[q.question.type];
}

export function QuestionHeader({ q }: { q: QuestionInfo }) {
  return (
    <>
      <p className={styles.eyebrow}>
        Question {q.index + 1} of {q.total}
      </p>
      <h1 className={styles.prompt}>{promptOf(q)}</h1>
    </>
  );
}
