import type { AnswerPayload, PublicQuestion } from '@zqhoot/protocol';
import { isTextQuestion } from '../../state/player.ts';
import type { PlayerView } from '../../state/player.ts';
import { AnswerOption } from '../../ui/AnswerOption.tsx';
import { Countdown } from '../../ui/Countdown.tsx';
import { StatusLine } from '../../ui/StatusLine.tsx';
import { AnswerInput } from './AnswerInput.tsx';
import { QuestionHeader } from './QuestionHeader.tsx';
import styles from './play.module.css';
import entryStyles from './TextEntry.module.css';

type QuestionView = Extract<PlayerView, { screen: 'answering' | 'submitted' }>;

/** What the player picked, shown without controls. */
function ChosenAnswer({
  question,
  responses,
}: {
  question: PublicQuestion;
  responses: readonly AnswerPayload[];
}) {
  const first = responses[0];
  if (!first) return null;
  if (first.kind === 'choice' && (question.type === 'single' || question.type === 'poll')) {
    const i = question.options.findIndex((o) => o.id === first.optionId);
    const option = question.options[i];
    return option ? <AnswerOption slot={i} text={option.text} chosen /> : null;
  }
  if (first.kind === 'boolean') {
    return <AnswerOption slot={first.value ? 0 : 1} text={first.value ? 'True' : 'False'} chosen />;
  }
  if (first.kind === 'rating' && question.type === 'rating') {
    return (
      <p className={styles.stat}>
        You rated {first.value} out of {question.max}
      </p>
    );
  }
  return null;
}

function sentTexts(responses: readonly AnswerPayload[]): string[] {
  return responses.flatMap((r) => (r.kind === 'text' ? [r.text] : []));
}

/**
 * `answering` and `submitted` share one component so a word-cloud player who has sent one
 * entry keeps the same input (and its focus) while they add more.
 */
export function QuestionScreen({
  view,
  onAnswer,
}: {
  view: QuestionView;
  onAnswer: (payload: AnswerPayload) => boolean;
}) {
  const { question } = view.q;
  const submitted = view.screen === 'submitted';
  const responses = submitted ? view.responses : [];
  const canAddMore = !submitted || view.remaining > 0;
  const text = isTextQuestion(question);

  return (
    <>
      <div className={styles.top}>
        <QuestionHeader q={view.q} />
        <Countdown {...view.timer} />
        <StatusLine>{view.notice}</StatusLine>
      </div>

      {submitted && !canAddMore && (
        <div className={styles.stack}>
          <h2 className={styles.lead}>
            {text ? 'Thanks, your response is in' : 'Answer locked in'}
          </h2>
          <ChosenAnswer question={question} responses={responses} />
          {text && (
            <ul className={entryStyles.entries} aria-label="Your responses">
              {sentTexts(responses).map((t, i) => (
                <li key={i} className={entryStyles.entry}>
                  {t}
                </li>
              ))}
            </ul>
          )}
          <p className={`${styles.muted} ${styles.eyebrow}`}>
            {view.sending ? 'Sending…' : 'Waiting for the question to close.'}
          </p>
        </div>
      )}

      {canAddMore && (
        <div className={styles.answers}>
          {submitted && text && <p className={styles.lead}>Thanks, your response is in.</p>}
          <AnswerInput
            key={view.q.index}
            question={question}
            onAnswer={onAnswer}
            sentTexts={sentTexts(responses)}
            remaining={submitted ? view.remaining : undefined}
            restore={view.restore}
          />
        </div>
      )}
    </>
  );
}
