import { useState } from 'react';
import { EditorScreen } from '../screens/edit/EditorScreen.tsx';
import { DashboardScreen } from '../screens/host/DashboardScreen.tsx';
import { LiveScreen } from '../screens/host/LiveScreen.tsx';
import { LoginScreen } from '../screens/host/LoginScreen.tsx';
import type { QuizDraft } from '../state/editor.ts';
import { JOIN_URL } from './fixtures/common.ts';
import {
  DEMO_IMAGE_URL,
  EDIT_BROKEN,
  EDIT_INDEX,
  EDIT_QUIZ,
  EDIT_WITH_IMAGE,
  issuesOf,
} from './fixtures/edit.ts';
import { DASHBOARD_QUIZZES, DASHBOARD_SESSIONS, HOST_LIVE_FIXTURES } from './fixtures/host.ts';
import type { HostLiveFixtureId } from './fixtures/host.ts';

const noop = () => undefined;

export function HostLoginFixture({ error = null }: { error?: string | null }) {
  return (
    <LoginScreen mode="local" busy={false} error={error} onLocalSubmit={noop} onCognito={noop} />
  );
}

export function HostDashboardFixture() {
  return (
    <DashboardScreen
      displayName="Alex Admin"
      onSignOut={noop}
      quizzes={DASHBOARD_QUIZZES}
      quizzesError={null}
      sessions={DASHBOARD_SESSIONS}
      sessionsError={null}
      busy={null}
      notice={null}
      onRetry={noop}
      onStart={noop}
      onDuplicate={noop}
      onDelete={noop}
      onOpenPresenter={noop}
      onDownloadCsv={noop}
    />
  );
}

export function HostLiveFixture({ id }: { id: HostLiveFixtureId }) {
  return (
    <LiveScreen
      state={HOST_LIVE_FIXTURES[id]}
      joinUrl={JOIN_URL}
      displayName="Alex Admin"
      onSignOut={noop}
      onNext={noop}
      onSkip={noop}
      onEnd={noop}
      onLock={noop}
      onKick={noop}
      onModerate={noop}
      onOpenPresenter={noop}
      onDismissNotice={noop}
    />
  );
}

export type EditFixture =
  | { kind: 'quiz' }
  | { kind: 'question'; type: keyof typeof EDIT_INDEX }
  | { kind: 'errors' }
  | { kind: 'conflict' };

/** Interactive, so a developer can edit in the gallery; nothing is saved anywhere. */
export function EditorFixture({ fixture }: { fixture: EditFixture }) {
  const initial: QuizDraft =
    fixture.kind === 'errors'
      ? EDIT_BROKEN
      : fixture.kind === 'question' && fixture.type === 'single'
        ? EDIT_WITH_IMAGE
        : EDIT_QUIZ;
  const [draft, setDraft] = useState<QuizDraft>(initial);
  const [open, setOpen] = useState<number | null>(
    fixture.kind === 'question' ? EDIT_INDEX[fixture.type] : fixture.kind === 'errors' ? 0 : null,
  );
  return (
    <EditorScreen
      isNew={false}
      draft={draft}
      onChange={setDraft}
      issues={fixture.kind === 'errors' ? issuesOf(draft) : []}
      summarySeq={0}
      openIndex={open}
      onOpen={setOpen}
      saveStatus="idle"
      saveError={null}
      conflict={fixture.kind === 'conflict'}
      dirty={fixture.kind === 'conflict'}
      urlFor={() => DEMO_IMAGE_URL}
      uploading={[]}
      uploadError={null}
      onSave={noop}
      onReload={noop}
      onOverwrite={noop}
      onFile={noop}
      displayName="Alex Admin"
      onSignOut={noop}
      leaving={false}
      onConfirmLeave={noop}
      onCancelLeave={noop}
    />
  );
}
