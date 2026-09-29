import { useCallback, useEffect, useState } from 'react';
import type { QuizSummary, SessionSummary } from '@zqhoot/protocol';
import { navigate } from '../../app/router.tsx';
import { toHref } from '../../app/routing.ts';
import { usePageTitle } from '../../app/usePageTitle.ts';
import type { HostAuth } from '../../auth/session.ts';
import { useHostApi } from '../../auth/useHostAuth.ts';
import { ApiRequestError } from '../../net/http.ts';
import { saveTextFile } from '../../net/hostApi.ts';
import { DashboardScreen } from './DashboardScreen.tsx';

export function errorText(err: unknown, what: string): string {
  if (err instanceof ApiRequestError) {
    if (err.status === 0)
      return `Couldn't reach the server, so ${what} did not happen. Check your connection.`;
    if (err.status === 401) return 'Your session ended. Sign in again.';
    return `${what[0]?.toUpperCase() ?? ''}${what.slice(1)} failed: ${err.message}`;
  }
  return `${what[0]?.toUpperCase() ?? ''}${what.slice(1)} failed.`;
}

/**
 * The presenter opens in its own window so it can be dragged to the projector. `window.open`
 * without `noopener` hands the new tab a copy of this tab's sessionStorage, which is how it is
 * already signed in; a plain `target="_blank"` link would not.
 */
export function openPresenter(sessionId: string): void {
  window.open(toHref('/present', { s: sessionId }), '_blank');
}

export function DashboardPage({
  auth,
  displayName,
}: {
  auth: HostAuth;
  displayName: string | null;
}) {
  usePageTitle('Your quizzes · zqhoot');
  const api = useHostApi(auth);
  const [quizzes, setQuizzes] = useState<QuizSummary[] | null>(null);
  const [sessions, setSessions] = useState<SessionSummary[] | null>(null);
  const [quizzesError, setQuizzesError] = useState<string | null>(null);
  const [sessionsError, setSessionsError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async () => {
    setQuizzesError(null);
    setSessionsError(null);
    const [q, s] = await Promise.allSettled([api.listQuizzes(), api.listSessions()]);
    if (q.status === 'fulfilled') {
      setQuizzes([...q.value].sort((a, b) => b.updatedAt - a.updatedAt));
    } else {
      setQuizzesError(errorText(q.reason, 'loading your quizzes'));
    }
    if (s.status === 'fulfilled') {
      setSessions([...s.value].sort((a, b) => b.createdAt - a.createdAt));
    } else {
      setSessionsError(errorText(s.reason, 'loading your sessions'));
    }
  }, [api]);

  useEffect(() => {
    void load();
  }, [load]);

  /** Runs one action on one item, with the item's buttons disabled meanwhile. */
  const act = async (id: string, what: string, run: () => Promise<string | void>) => {
    setBusy(id);
    setNotice(null);
    try {
      const done = await run();
      if (done) setNotice(done);
    } catch (err) {
      setNotice(errorText(err, what));
    } finally {
      setBusy(null);
    }
  };

  return (
    <DashboardScreen
      displayName={displayName}
      onSignOut={() => auth.signOut()}
      quizzes={quizzes}
      quizzesError={quizzesError}
      sessions={sessions}
      sessionsError={sessionsError}
      busy={busy}
      notice={notice}
      onRetry={() => void load()}
      onStart={(quizId) =>
        void act(quizId, 'starting the session', async () => {
          const { sessionId } = await api.createSession(quizId);
          navigate(toHref('/host/live', { s: sessionId }));
        })
      }
      onDuplicate={(quizId) =>
        void act(quizId, 'duplicating the quiz', async () => {
          const copy = await api.duplicateQuiz(quizId);
          await load();
          return `Duplicated as “${copy.title}”.`;
        })
      }
      onDelete={(quizId) =>
        void act(quizId, 'deleting the quiz', async () => {
          await api.deleteQuiz(quizId);
          await load();
          return 'Quiz deleted.';
        })
      }
      onOpenPresenter={openPresenter}
      onDownloadCsv={(sessionId) =>
        void act(sessionId, 'downloading the results', async () => {
          const csv = await api.downloadResults(sessionId);
          const pin = sessions?.find((s) => s.sessionId === sessionId)?.pin ?? sessionId;
          saveTextFile(`zqhoot-results-${pin}.csv`, csv);
          return 'Results downloaded.';
        })
      }
    />
  );
}
