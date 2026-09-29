import { useEffect, useRef, useState } from 'react';
import type { ModerationStatus, OpenResponseView } from '@zqhoot/protocol';
import { Button } from '../../ui/Button.tsx';
import { rescueFocus } from '../../ui/focus.ts';
import styles from './Host.module.css';

const short = (text: string) => (text.length > 40 ? `${text.slice(0, 40)}…` : text);

function Item({
  response,
  action,
  onModerate,
}: {
  response: OpenResponseView;
  action: 'visible' | 'hidden';
  onModerate?: () => void;
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
          onClick={onModerate}
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
  status,
  title,
  empty,
  responses,
  action,
  onModerate,
}: {
  id: string;
  status: ModerationStatus;
  title: string;
  empty: string;
  responses: OpenResponseView[];
  action: 'visible' | 'hidden';
  onModerate?: (response: OpenResponseView, index: number) => void;
}) {
  return (
    <div className={styles.group} role="group" aria-labelledby={id} data-group={status}>
      {/* Focusable by script, not by Tab: where focus lands when the last response leaves. */}
      <h3 id={id} className={styles.h3} tabIndex={-1}>
        {title} ({responses.length})
      </h3>
      {responses.length === 0 ? (
        <p className={styles.meta}>{empty}</p>
      ) : (
        <ul className={styles.responses}>
          {responses.map((r, i) => (
            <Item
              key={r.id}
              response={r}
              action={action}
              onModerate={onModerate && (() => onModerate(r, i))}
            />
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
 *
 * Show and Hide move a response to another list, which removes the button that has focus. Focus
 * then goes to the response that took its place in the same list (its first action), or to the
 * list's heading when it is now empty, so working down a queue by keyboard never restarts from
 * the top of the page.
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
  const root = useRef<HTMLDivElement>(null);
  const [left, setLeft] = useState<{ group: ModerationStatus; index: number } | null>(null);

  // Set in the same event as the change to `responses`, so this runs once the list has updated.
  useEffect(() => {
    if (left === null) return;
    setLeft(null);
    const group = root.current?.querySelector<HTMLElement>(`[data-group="${left.group}"]`);
    if (!group) return;
    const buttons = group.querySelectorAll<HTMLElement>('li button');
    rescueFocus(buttons[Math.min(left.index, buttons.length - 1)] ?? group.querySelector('h3'));
  }, [left]);

  const by = (status: ModerationStatus) =>
    responses.filter((r) => r.status === status).sort(newestFirst);
  const moderate = (
    status: ModerationStatus,
    to: 'visible' | 'hidden',
  ): ((response: OpenResponseView, index: number) => void) | undefined =>
    onModerate &&
    ((response, index) => {
      setLeft({ group: status, index });
      onModerate(response.id, to);
    });

  return (
    <div className={styles.moderation} ref={root}>
      <Group
        id="mod-pending"
        status="pending"
        title="Waiting for approval"
        empty="Nothing is waiting."
        responses={by('pending')}
        action="visible"
        onModerate={moderate('pending', 'visible')}
      />
      <Group
        id="mod-visible"
        status="visible"
        title="On the big screen"
        empty="Nothing is showing yet."
        responses={by('visible')}
        action="hidden"
        onModerate={moderate('visible', 'hidden')}
      />
      <Group
        id="mod-hidden"
        status="hidden"
        title="Hidden"
        empty="Nothing is hidden."
        responses={by('hidden')}
        action="visible"
        onModerate={moderate('hidden', 'visible')}
      />
    </div>
  );
}
