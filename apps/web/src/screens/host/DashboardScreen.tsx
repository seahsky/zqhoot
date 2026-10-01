import { useEffect, useRef, useState } from 'react';
import type { QuizSummary, SessionSummary } from '@zqhoot/protocol';
import { formatPin } from '../../state/charts.ts';
import { Button, ButtonLink } from '../../ui/Button.tsx';
import { ConfirmDialog } from '../../ui/ConfirmDialog.tsx';
import { rescueFocus } from '../../ui/focus.ts';
import { HostShell } from '../../ui/HostShell.tsx';
import { StatusLine } from '../../ui/StatusLine.tsx';
import { toHref } from '../../app/routing.ts';
import { PHASE_LABEL, formatWhen, questionCountLabel } from './format.ts';
import styles from './Host.module.css';

export interface DashboardScreenProps {
  displayName: string | null;
  onSignOut: () => void;
  /** null while loading. */
  quizzes: QuizSummary[] | null;
  quizzesError: string | null;
  sessions: SessionSummary[] | null;
  sessionsError: string | null;
  /** Id of the quiz or session an action is running on, so its buttons can wait. */
  busy: string | null;
  /** Result of the last action, announced politely. */
  notice: string | null;
  onRetry: () => void;
  onStart: (quizId: string) => void;
  onDuplicate: (quizId: string) => void;
  onDelete: (quizId: string) => void;
  onOpenPresenter: (sessionId: string) => void;
  onDownloadCsv: (sessionId: string) => void;
}

function QuizCard(p: {
  quiz: QuizSummary;
  busy: boolean;
  onStart: () => void;
  onDuplicate: () => void;
  onDelete: () => void;
}) {
  const { quiz } = p;
  return (
    <li className={styles.card}>
      <div className={styles.cardHead}>
        <h3 className={styles.cardTitle}>{quiz.title}</h3>
        <p className={styles.meta}>
          {questionCountLabel(quiz.questionCount)} ·{' '}
          <span className={styles.nowrap}>edited {formatWhen(quiz.updatedAt)}</span>
        </p>
      </div>
      <div className={styles.actions}>
        {/* aria-disabled, not disabled, while an action runs: a disabled button loses focus. */}
        <Button
          size="compact"
          onClick={() => !p.busy && p.onStart()}
          aria-disabled={p.busy || undefined}
        >
          Start session
        </Button>
        <ButtonLink
          size="compact"
          variant="secondary"
          to={toHref('/edit', { q: quiz.id })}
          aria-label={`Edit ${quiz.title}`}
        >
          Edit
        </ButtonLink>
        <Button
          size="compact"
          variant="secondary"
          onClick={() => !p.busy && p.onDuplicate()}
          aria-disabled={p.busy || undefined}
          aria-label={`Duplicate ${quiz.title}`}
        >
          Duplicate
        </Button>
        <Button
          size="compact"
          variant="secondary"
          onClick={() => !p.busy && p.onDelete()}
          aria-disabled={p.busy || undefined}
          aria-label={`Delete ${quiz.title}`}
        >
          Delete
        </Button>
      </div>
    </li>
  );
}

function SessionCard(p: {
  session: SessionSummary;
  busy: boolean;
  onOpenPresenter: () => void;
  onDownloadCsv: () => void;
}) {
  const { session } = p;
  return (
    <li className={styles.card}>
      <div className={styles.cardHead}>
        <h3 className={styles.cardTitle}>{session.quizTitle}</h3>
        <p className={styles.meta}>
          <span className={styles.nowrap}>PIN {formatPin(session.pin)}</span> ·{' '}
          {PHASE_LABEL[session.phase]} ·{' '}
          <span className={styles.nowrap}>started {formatWhen(session.createdAt)}</span>
        </p>
      </div>
      <div className={styles.actions}>
        <ButtonLink
          size="compact"
          to={toHref('/host/live', { s: session.sessionId })}
          aria-label={`Open control for ${session.quizTitle}`}
        >
          Open control
        </ButtonLink>
        <Button
          size="compact"
          variant="secondary"
          onClick={p.onOpenPresenter}
          aria-label={`Open presenter for ${session.quizTitle}`}
        >
          Open presenter
        </Button>
        <Button
          size="compact"
          variant="secondary"
          onClick={() => !p.busy && p.onDownloadCsv()}
          aria-disabled={p.busy || undefined}
          aria-label={`Download results for ${session.quizTitle} as CSV`}
        >
          Download CSV
        </Button>
      </div>
    </li>
  );
}

function Problem({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div className={styles.problemBox}>
      <p role="alert" className={styles.problem}>
        {message}
      </p>
      <Button size="compact" variant="secondary" onClick={onRetry}>
        Try again
      </Button>
    </div>
  );
}

/** How long after a delete the card may still be listed before we stop waiting to move focus. */
const DELETE_FOCUS_WAIT_MS = 15_000;

/**
 * Quizzes to start, edit, duplicate or delete, and recent sessions to reopen or export. A deleted
 * quiz takes its Delete button, which had focus, with it: focus goes to the quiz that took its
 * place (its first action), or to New quiz when none is left.
 */
export function DashboardScreen(p: DashboardScreenProps) {
  const [pendingDelete, setPendingDelete] = useState<QuizSummary | null>(null);
  const list = useRef<HTMLUListElement>(null);
  const deleted = useRef<{ id: string; index: number; until: number } | null>(null);

  useEffect(() => {
    const plan = deleted.current;
    if (!plan || p.quizzes === null) return;
    if (Date.now() > plan.until) {
      deleted.current = null;
      return;
    }
    if (p.quizzes.some((q) => q.id === plan.id)) return; // not gone yet
    deleted.current = null;
    const cards = list.current?.querySelectorAll<HTMLElement>(':scope > li') ?? [];
    const next =
      cards[Math.min(plan.index, cards.length - 1)]?.querySelector<HTMLElement>('button, a');
    rescueFocus(next ?? document.querySelector<HTMLElement>('[data-focus="new-quiz"]'));
  }, [p.quizzes]);

  return (
    <HostShell displayName={p.displayName} onSignOut={p.onSignOut}>
      <StatusLine className={styles.statusSlot}>{p.notice}</StatusLine>

      <section className={styles.section} aria-labelledby="quizzes-title">
        <div className={styles.sectionHead}>
          <h1 id="quizzes-title">Your quizzes</h1>
          <ButtonLink to="/edit?q=new" size="compact" data-focus="new-quiz">
            New quiz
          </ButtonLink>
        </div>
        {p.quizzesError ? (
          <Problem message={p.quizzesError} onRetry={p.onRetry} />
        ) : p.quizzes === null ? (
          <p className={styles.lead}>Loading your quizzes…</p>
        ) : p.quizzes.length === 0 ? (
          <p className={styles.lead}>
            You have no quizzes yet. Create one, then start a session from here.
          </p>
        ) : (
          <ul className={styles.list} ref={list}>
            {p.quizzes.map((quiz) => (
              <QuizCard
                key={quiz.id}
                quiz={quiz}
                busy={p.busy === quiz.id}
                onStart={() => p.onStart(quiz.id)}
                onDuplicate={() => p.onDuplicate(quiz.id)}
                onDelete={() => setPendingDelete(quiz)}
              />
            ))}
          </ul>
        )}
      </section>

      <section className={styles.section} aria-labelledby="sessions-title">
        <h2 id="sessions-title" className={styles.h2}>
          Recent sessions
        </h2>
        {p.sessionsError ? (
          <Problem message={p.sessionsError} onRetry={p.onRetry} />
        ) : p.sessions === null ? (
          <p className={styles.lead}>Loading your sessions…</p>
        ) : p.sessions.length === 0 ? (
          <p className={styles.lead}>No sessions yet. Start one from a quiz above.</p>
        ) : (
          <ul className={styles.list}>
            {p.sessions.map((session) => (
              <SessionCard
                key={session.sessionId}
                session={session}
                busy={p.busy === session.sessionId}
                onOpenPresenter={() => p.onOpenPresenter(session.sessionId)}
                onDownloadCsv={() => p.onDownloadCsv(session.sessionId)}
              />
            ))}
          </ul>
        )}
      </section>

      <ConfirmDialog
        open={pendingDelete !== null}
        title="Delete this quiz?"
        body={
          pendingDelete
            ? `“${pendingDelete.title}” and its questions will be deleted. Past sessions keep their results.`
            : ''
        }
        confirmLabel="Delete quiz"
        onCancel={() => setPendingDelete(null)}
        onConfirm={() => {
          if (pendingDelete) {
            deleted.current = {
              id: pendingDelete.id,
              index: p.quizzes?.findIndex((q) => q.id === pendingDelete.id) ?? 0,
              until: Date.now() + DELETE_FOCUS_WAIT_MS,
            };
            p.onDelete(pendingDelete.id);
          }
          setPendingDelete(null);
        }}
      />
    </HostShell>
  );
}
