import type { ModerationStatus, OpenResponseView } from '@zqhoot/protocol';
import { Button } from '../../ui/Button.tsx';
import styles from './Host.module.css';

const short = (text: string) => (text.length > 40 ? `${text.slice(0, 40)}…` : text);

function Item({
  response,
  action,
  onModerate,
}: {
  response: OpenResponseView;
  action: 'visible' | 'hidden';
  onModerate?: (responseId: string, status: 'visible' | 'hidden') => void;
}) {
  const who = response.nickname ?? 'A player';
  return (
    <li className={styles.response}>
      <div className={styles.responseText}>
        <p className={styles.responseBody}>{response.text}</p>
        <p className={styles.meta}>{who}</p>
      </div>
      {onModerate && (
        <Button
          size="compact"
          variant={action === 'visible' ? 'primary' : 'secondary'}
          onClick={() => onModerate(response.id, action)}
          aria-label={`${action === 'visible' ? 'Show' : 'Hide'} ${who}'s response: ${short(response.text)}`}
        >
          {action === 'visible' ? 'Show' : 'Hide'}
        </Button>
      )}
    </li>
  );
}

function Group({
  id,
  title,
  empty,
  responses,
  action,
  onModerate,
}: {
  id: string;
  title: string;
  empty: string;
  responses: OpenResponseView[];
  action: 'visible' | 'hidden';
  onModerate?: (responseId: string, status: 'visible' | 'hidden') => void;
}) {
  return (
    <div className={styles.group} role="group" aria-labelledby={id}>
      <h3 id={id} className={styles.h3}>
        {title} ({responses.length})
      </h3>
      {responses.length === 0 ? (
        <p className={styles.meta}>{empty}</p>
      ) : (
        <ul className={styles.responses}>
          {responses.map((r) => (
            <Item key={r.id} response={r} action={action} onModerate={onModerate} />
          ))}
        </ul>
      )}
    </div>
  );
}

const newestFirst = (a: OpenResponseView, b: OpenResponseView) =>
  b.receivedAt - a.receivedAt || (a.id < b.id ? 1 : -1);

/**
 * Open-ended responses waiting for the host, those on the projector, and those hidden. Every
 * button is a real button, so the queue works from the keyboard alone. `onModerate` is
 * omitted once the question has closed: the projector's results are already fixed.
 */
export function Moderation({
  responses,
  onModerate,
}: {
  responses: readonly OpenResponseView[];
  onModerate?: (
    responseId: string,
    status: Extract<ModerationStatus, 'visible' | 'hidden'>,
  ) => void;
}) {
  const by = (status: ModerationStatus) =>
    responses.filter((r) => r.status === status).sort(newestFirst);
  return (
    <div className={styles.moderation}>
      <Group
        id="mod-pending"
        title="Waiting for approval"
        empty="Nothing is waiting."
        responses={by('pending')}
        action="visible"
        onModerate={onModerate}
      />
      <Group
        id="mod-visible"
        title="On the big screen"
        empty="Nothing is showing yet."
        responses={by('visible')}
        action="hidden"
        onModerate={onModerate}
      />
      <Group
        id="mod-hidden"
        title="Hidden"
        empty="Nothing is hidden."
        responses={by('hidden')}
        action="visible"
        onModerate={onModerate}
      />
    </div>
  );
}
