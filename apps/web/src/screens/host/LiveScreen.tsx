import { Fragment, useRef, useState } from 'react';
import type { HostSnapshot, ModerationStatus } from '@zqhoot/protocol';
import { formatPin } from '../../state/charts.ts';
import { nextAction } from '../../state/commands.ts';
import { playerCount } from '../../state/host.ts';
import type { HostState } from '../../state/host.ts';
import { typeLabel } from '../../state/editor.ts';
import { Button, ButtonLink } from '../../ui/Button.tsx';
import { ConfirmDialog } from '../../ui/ConfirmDialog.tsx';
import { useFocusFallback } from '../../ui/focus.ts';
import { HostShell } from '../../ui/HostShell.tsx';
import { StatusLine } from '../../ui/StatusLine.tsx';
import { Distribution } from './Distribution.tsx';
import { Moderation } from './Moderation.tsx';
import { Roster } from './Roster.tsx';
import { FORBIDDEN_COPY, PHASE_LABEL, playerCountLabel } from './format.ts';
import styles from './Host.module.css';

export interface LiveScreenProps {
  state: HostState;
  /** Where players go, shown as text. */
  joinUrl: string;
  displayName: string | null;
  onSignOut: () => void;
  onNext: () => void;
  onSkip: () => void;
  onEnd: () => void;
  onLock: (locked: boolean) => void;
  onKick: (playerId: string) => void;
  onModerate: (responseId: string, status: Extract<ModerationStatus, 'visible' | 'hidden'>) => void;
  onOpenPresenter: () => void;
  onDismissNotice: () => void;
}

function connectionText(status: HostState['connection']): string {
  if (status === 'connecting') return 'Connecting…';
  if (status === 'reconnecting') return 'Reconnecting…';
  return '';
}

/**
 * The URL is read aloud and typed in, so it may only break after a slash or a dot, and never
 * inside its scheme prefix. A break opportunity adds no text, so copying still gives the whole URL.
 */
function BreakableUrl({ url }: { url: string }) {
  return url.split(/(?<=[/.])(?!\/)/).map((part, i) => (
    <Fragment key={i}>
      {i > 0 && <wbr />}
      {part}
    </Fragment>
  ));
}

function Summary({
  snap,
  players,
  joinUrl,
}: {
  snap: HostSnapshot;
  /** The live roster's size: `snap.roster` is as old as the last snapshot, empty in the lobby. */
  players: number;
  joinUrl: string;
}) {
  const q =
    snap.questionIndex >= 0 ? `Question ${snap.questionIndex + 1} of ${snap.totalQuestions}` : null;
  return (
    <div className={styles.summary}>
      <p className={styles.eyebrow}>Live session</p>
      <h1>{snap.quizTitle}</h1>
      <ul className={styles.chips}>
        <li className={styles.chip}>{PHASE_LABEL[snap.phase]}</li>
        {q && <li className={styles.chip}>{q}</li>}
        <li className={styles.chip}>{playerCountLabel(players)}</li>
        {snap.locked && <li className={styles.chip}>Joining locked</li>}
      </ul>
      <p className={styles.join}>
        Players join at{' '}
        <strong className={styles.joinUrl}>
          <BreakableUrl url={joinUrl} />
        </strong>{' '}
        with PIN <strong className={styles.pin}>{formatPin(snap.pin)}</strong>
      </p>
    </div>
  );
}

function Controls(p: {
  snap: HostSnapshot;
  onNext: () => void;
  onSkip: () => void;
  onLock: (locked: boolean) => void;
  onOpenPresenter: () => void;
  onAskEnd: () => void;
}) {
  const action = nextAction(p.snap);
  const ended = p.snap.phase === 'ended';
  const panel = useRef<HTMLElement>(null);
  // Skip question goes with the question, and End session and Lock joining with the game. When
  // the one that had focus goes, focus moves to Next, or to the panel's heading when Next is done.
  const keepFocus = useFocusFallback(
    panel,
    (el) =>
      el.querySelector<HTMLElement>('[data-focus="next"]:not(:disabled)') ?? el.querySelector('h2'),
  );
  return (
    <section ref={panel} className={styles.panel} aria-labelledby="control-title" {...keepFocus}>
      <h2 id="control-title" className={styles.h2} tabIndex={-1}>
        Control
      </h2>
      <Button
        block
        onClick={p.onNext}
        disabled={action.command === null}
        className={styles.next}
        data-focus="next"
      >
        {action.label}
      </Button>
      <p className={styles.meta}>{action.hint}</p>
      <div className={styles.actions}>
        {p.snap.phase === 'question' && (
          <Button size="compact" variant="secondary" onClick={p.onSkip}>
            Skip question
          </Button>
        )}
        {!ended && (
          <Button
            size="compact"
            variant="secondary"
            onClick={() => p.onLock(!p.snap.locked)}
            aria-pressed={p.snap.locked}
          >
            {p.snap.locked ? 'Unlock joining' : 'Lock joining'}
          </Button>
        )}
        <Button size="compact" variant="secondary" onClick={p.onOpenPresenter}>
          Open presenter
        </Button>
        {!ended && (
          <Button size="compact" variant="secondary" onClick={p.onAskEnd}>
            End session
          </Button>
        )}
      </div>
    </section>
  );
}

function Current({
  state,
  snap,
  onModerate,
}: {
  state: HostState;
  snap: HostSnapshot;
  onModerate: LiveScreenProps['onModerate'];
}) {
  const hosted = snap.question;
  if (!hosted) return null;
  const q = hosted.question;
  const open = snap.phase === 'question';
  const responses =
    state.live?.responses ?? (snap.result?.type === 'open' ? snap.result.responses : []);
  const moderated = q.type === 'open';
  return (
    <section className={styles.panel} aria-labelledby="question-title">
      <h2 id="question-title" className={styles.h2}>
        Now: {typeLabel(q.type)}
      </h2>
      <p className={styles.prompt}>{q.prompt}</p>
      <Distribution question={q} stats={state.live?.stats ?? null} result={snap.result ?? null} />
      {moderated && (
        <div>
          <h3 className={styles.h3}>Responses</h3>
          {open ? (
            <p className={styles.meta}>
              {q.type === 'open' && q.requireApproval
                ? 'New responses wait here until you show them.'
                : 'Responses show at once. Hide any you do not want on the big screen.'}
            </p>
          ) : (
            <p className={styles.meta}>The question has closed, so the big screen is fixed.</p>
          )}
          <Moderation responses={responses} onModerate={open ? onModerate : undefined} />
        </div>
      )}
    </section>
  );
}

/**
 * Live control for a session: the big Next button, the question and its numbers, the moderation
 * queue for open-ended responses, and everyone in the room. It is a view over `HostState`; the
 * container turns button presses into protocol commands.
 */
export function LiveScreen(p: LiveScreenProps) {
  const { state } = p;
  const snap = state.snapshot;
  const [confirmEnd, setConfirmEnd] = useState(false);

  return (
    <HostShell displayName={p.displayName} onSignOut={p.onSignOut}>
      <StatusLine className={styles.statusSlot}>{connectionText(state.connection)}</StatusLine>
      {state.notice && (
        <div className={styles.noticeBox}>
          <p role="alert" className={styles.problem}>
            {state.notice.message}
          </p>
          <Button size="compact" variant="secondary" onClick={p.onDismissNotice}>
            Dismiss
          </Button>
        </div>
      )}

      {state.ended ? (
        <div className={styles.narrow}>
          <h1>{endedTitle(state.ended)}</h1>
          <p className={styles.lead}>{endedBody(state.ended)}</p>
          <div className={styles.actions}>
            <ButtonLink to="/host">Back to your quizzes</ButtonLink>
            {state.ended === 'forbidden' && (
              <Button variant="secondary" onClick={p.onSignOut}>
                Sign out and switch account
              </Button>
            )}
          </div>
        </div>
      ) : snap === null ? (
        <div className={styles.narrow}>
          <h1>Connecting…</h1>
          <p className={styles.lead}>Finding your session.</p>
        </div>
      ) : (
        <>
          <Summary snap={snap} players={playerCount(state)} joinUrl={p.joinUrl} />
          <div className={styles.columns}>
            <div className={styles.main}>
              <Controls
                snap={snap}
                onNext={p.onNext}
                onSkip={p.onSkip}
                onLock={p.onLock}
                onOpenPresenter={p.onOpenPresenter}
                onAskEnd={() => setConfirmEnd(true)}
              />
              <Current state={state} snap={snap} onModerate={p.onModerate} />
            </div>
            <section className={styles.panel} aria-labelledby="players-title">
              <h2 id="players-title" className={styles.h2}>
                Players
              </h2>
              <Roster roster={state.roster} onKick={p.onKick} />
            </section>
          </div>
        </>
      )}

      <ConfirmDialog
        open={confirmEnd}
        title="End this session?"
        body="The game ends for everyone and the final results are shown. This cannot be undone."
        confirmLabel="End session"
        onCancel={() => setConfirmEnd(false)}
        onConfirm={() => {
          setConfirmEnd(false);
          p.onEnd();
        }}
      />
    </HostShell>
  );
}

function endedTitle(reason: NonNullable<HostState['ended']>): string {
  switch (reason) {
    case 'session-ended':
      return 'This session has ended';
    case 'not-found':
      return "We couldn't find this session";
    case 'unauthorized':
      return 'Your sign-in ended';
    case 'forbidden':
      return FORBIDDEN_COPY.title;
    case 'out-of-date':
      return 'This page is out of date';
  }
}

function endedBody(reason: NonNullable<HostState['ended']>): string {
  switch (reason) {
    case 'session-ended':
      return 'Results are on your dashboard, where you can download them.';
    case 'not-found':
      return 'It may have expired, or the link may be wrong.';
    case 'unauthorized':
      return 'Go back to the dashboard and sign in again.';
    case 'forbidden':
      return FORBIDDEN_COPY.body;
    case 'out-of-date':
      return 'Reload the page to carry on.';
  }
}
