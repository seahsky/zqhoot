import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { navigate, useRoute } from '../../app/router.tsx';
import { toHref } from '../../app/routing.ts';
import { usePageTitle } from '../../app/usePageTitle.ts';
import type { HostAuth } from '../../auth/session.ts';
import { useHostApi } from '../../auth/useHostAuth.ts';
import { getRuntimeConfig } from '../../config/runtime.ts';
import { ApiRequestError } from '../../net/http.ts';
import { mediaUrl, uploadImage } from '../../net/upload.ts';
import {
  draftAfterSave,
  draftFromQuiz,
  isDirty,
  newDraft,
  setQuestionImage,
  validateDraft,
} from '../../state/editor.ts';
import type { FieldIssue, QuizDraft } from '../../state/editor.ts';
import { ButtonLink } from '../../ui/Button.tsx';
import { HostShell } from '../../ui/HostShell.tsx';
import { HostGate } from '../host/HostGate.tsx';
import { errorText } from '../host/DashboardPage.tsx';
import { EditorScreen } from './EditorScreen.tsx';
import type { SaveStatus } from './EditorScreen.tsx';

/** `/edit?q={quizId|new}`. */
export function EditPage() {
  const route = useRoute();
  usePageTitle('Quiz editor · zqhoot');
  const q = route.query.get('q');
  return (
    <HostGate>
      {({ auth, displayName }) =>
        q ? (
          <Editor auth={auth} displayName={displayName} quizId={q} />
        ) : (
          <HostShell displayName={displayName} onSignOut={() => auth.signOut()}>
            <h1>No quiz to edit</h1>
            <p>Pick a quiz on your dashboard, or start a new one.</p>
            <ButtonLink to="/edit?q=new">New quiz</ButtonLink>
          </HostShell>
        )
      }
    </HostGate>
  );
}

interface Loaded {
  /** null for a quiz that has not been saved yet. */
  id: string | null;
  version: number | null;
  draft: QuizDraft;
}

function Editor({
  auth,
  displayName,
  quizId,
}: {
  auth: HostAuth;
  displayName: string | null;
  quizId: string;
}) {
  const api = useHostApi(auth);
  const config = getRuntimeConfig();
  const isNew = quizId === 'new';

  // What the editor holds and what the server has: `saved` is the baseline for "unsaved changes".
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [draft, setDraft] = useState<QuizDraft | null>(null);
  const [saved, setSaved] = useState<QuizDraft | null>(null);
  const version = useRef<number | null>(null);
  const savedId = useRef<string | null>(null);

  const [openIndex, setOpenIndex] = useState<number | null>(0);
  const [attempted, setAttempted] = useState(false);
  const [summarySeq, setSummarySeq] = useState(0);
  const [saveStatus, setSaveStatus] = useState<SaveStatus>('idle');
  const [saveError, setSaveError] = useState<string | null>(null);
  const [conflict, setConflict] = useState(false);
  // By question id: the host may move or delete questions while an upload runs.
  const [uploading, setUploading] = useState<readonly string[]>([]);
  const [uploadError, setUploadError] = useState<{ questionId: string; message: string } | null>(
    null,
  );
  const [leaveTarget, setLeaveTarget] = useState<string | null>(null);

  // --- loading -----------------------------------------------------------------------------

  const adopt = useCallback((next: Loaded) => {
    setLoaded(next);
    setDraft(next.draft);
    setSaved(next.draft);
    version.current = next.version;
    savedId.current = next.id;
  }, []);

  useEffect(() => {
    // A save of a new quiz changes the URL to the new id; the editor already holds that quiz.
    if (savedId.current === quizId) return;
    let cancelled = false;
    setLoadError(null);
    if (isNew) {
      adopt({ id: null, version: null, draft: newDraft() });
      return;
    }
    setLoaded(null);
    api
      .getQuiz(quizId)
      .then((quiz) => {
        if (!cancelled) adopt({ id: quiz.id, version: quiz.version, draft: draftFromQuiz(quiz) });
      })
      .catch((err) => {
        if (!cancelled) setLoadError(errorText(err, 'loading the quiz'));
      });
    return () => {
      cancelled = true;
    };
  }, [api, quizId, isNew, adopt]);

  const dirty = draft !== null && saved !== null && isDirty(draft, saved);

  // --- leaving with unsaved changes ---------------------------------------------------------

  useEffect(() => {
    if (!dirty) return;
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      // The browser shows its own wording; the assignment is what makes it ask.
      e.preventDefault();
      e.returnValue = '';
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, [dirty]);

  const onLeave = useCallback(
    (to: string) => {
      if (!dirty) return true;
      setLeaveTarget(to);
      return false;
    },
    [dirty],
  );

  // --- validation --------------------------------------------------------------------------

  /** After the first failed save the list follows every edit, so fixed problems disappear. */
  const issues: FieldIssue[] = useMemo(() => {
    if (!attempted || !draft) return [];
    const r = validateDraft(draft);
    return r.ok ? [] : r.issues;
  }, [attempted, draft]);

  // --- saving ------------------------------------------------------------------------------

  const commit = async (
    sent: QuizDraft,
    input: Extract<ReturnType<typeof validateDraft>, { ok: true }>['input'],
    overwrite: boolean,
  ) => {
    setSaveStatus('saving');
    setSaveError(null);
    try {
      let quiz;
      if (savedId.current === null) {
        quiz = await api.createQuiz(input);
      } else {
        // Overwriting means taking the server's current version number and saving on top of it.
        const expected = overwrite
          ? (await api.getQuiz(savedId.current)).version
          : (version.current ?? 0);
        quiz = await api.updateQuiz(savedId.current, expected, input);
      }
      const next = draftFromQuiz(quiz);
      const wasNew = savedId.current === null;
      setLoaded({ id: quiz.id, version: quiz.version, draft: next });
      // Edits made while the request was out are kept, and show as unsaved.
      setDraft((current) => (current === null ? next : draftAfterSave(current, sent, next)));
      setSaved(next);
      version.current = quiz.version;
      savedId.current = quiz.id;
      setConflict(false);
      setAttempted(false);
      setSaveStatus('saved');
      if (wasNew) navigate(toHref('/edit', { q: quiz.id }), { replace: true });
    } catch (err) {
      if (err instanceof ApiRequestError && err.status === 409) {
        setConflict(true);
        setSaveStatus('idle');
        return;
      }
      setSaveStatus('error');
      setSaveError(errorText(err, 'saving the quiz'));
    }
  };

  const onSave = () => {
    if (!draft) return;
    const r = validateDraft(draft);
    if (!r.ok) {
      setAttempted(true);
      setSummarySeq((n) => n + 1);
      const first = r.issues.find((i) => i.question !== null);
      if (first?.question != null) setOpenIndex(first.question);
      return;
    }
    void commit(draft, r.input, false);
  };

  const onOverwrite = () => {
    if (!draft) return;
    const r = validateDraft(draft);
    if (!r.ok) {
      setConflict(false);
      setAttempted(true);
      setSummarySeq((n) => n + 1);
      return;
    }
    void commit(draft, r.input, true);
  };

  const onReload = () => {
    const id = savedId.current;
    if (!id) return;
    setSaveError(null);
    api
      .getQuiz(id)
      .then((quiz) => {
        adopt({ id: quiz.id, version: quiz.version, draft: draftFromQuiz(quiz) });
        setConflict(false);
        setAttempted(false);
        setSaveStatus('idle');
      })
      .catch((err) => setSaveError(errorText(err, 'loading the latest version')));
  };

  // --- images ------------------------------------------------------------------------------

  const onFile = async (questionId: string, file: File) => {
    setUploadError((e) => (e?.questionId === questionId ? null : e));
    setUploading((ids) => (ids.includes(questionId) ? ids : [...ids, questionId]));
    try {
      const key = await uploadImage(file, {
        requestGrant: api.requestUpload,
        apiBaseUrl: config.apiBaseUrl,
      });
      // Found by id now, not by where the question was when the upload started.
      setDraft((current) => (current ? setQuestionImage(current, questionId, key) : current));
    } catch (err) {
      setUploadError({
        questionId,
        message: err instanceof ApiRequestError ? err.message : 'The image could not be added.',
      });
    } finally {
      setUploading((ids) => ids.filter((id) => id !== questionId));
    }
  };

  // --- render ------------------------------------------------------------------------------

  if (loadError) {
    return (
      <HostShell displayName={displayName} onSignOut={() => auth.signOut()}>
        <h1>We couldn't open that quiz</h1>
        <p role="alert">{loadError}</p>
        <ButtonLink to="/host">Back to your quizzes</ButtonLink>
      </HostShell>
    );
  }
  if (!loaded || !draft) {
    return (
      <HostShell displayName={displayName} onSignOut={() => auth.signOut()}>
        <h1>Opening the quiz…</h1>
      </HostShell>
    );
  }

  return (
    <EditorScreen
      isNew={loaded.id === null}
      draft={draft}
      onChange={setDraft}
      issues={issues}
      summarySeq={summarySeq}
      openIndex={openIndex}
      onOpen={setOpenIndex}
      saveStatus={saveStatus}
      saveError={saveError}
      conflict={conflict}
      dirty={dirty}
      urlFor={(key) => mediaUrl(config.mediaBaseUrl, key)}
      uploading={uploading}
      uploadError={uploadError}
      onSave={onSave}
      onReload={onReload}
      onOverwrite={onOverwrite}
      onFile={(questionId, file) => void onFile(questionId, file)}
      displayName={displayName}
      onSignOut={() => auth.signOut()}
      onLeave={onLeave}
      leaveTarget={leaveTarget}
      onConfirmLeave={() => {
        const to = leaveTarget;
        setLeaveTarget(null);
        if (to) navigate(to);
      }}
      onCancelLeave={() => setLeaveTarget(null)}
    />
  );
}
