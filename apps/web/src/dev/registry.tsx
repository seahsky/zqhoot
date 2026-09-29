import { useState } from 'react';
import type { ReactNode } from 'react';
import { Landing } from '../screens/landing/Landing.tsx';
import { JoinNicknameScreen } from '../screens/join/JoinNicknameScreen.tsx';
import { JoinPinScreen } from '../screens/join/JoinPinScreen.tsx';
import { PlayScreen } from '../screens/play/PlayScreen.tsx';
import {
  EditorFixture,
  HostDashboardFixture,
  HostLiveFixture,
  HostLoginFixture,
} from './HostFixtures.tsx';
import { PresentFixtureScreen } from './PresentFixture.tsx';
import { QUIZ_TITLE } from './fixtures/common.ts';
import { PLAY_FIXTURES } from './fixtures/player.ts';
import type { PlayFixtureId } from './fixtures/player.ts';
import type { ScreenId } from './manifest.ts';

const noop = () => undefined;
const sent = () => true;

/** Interactive, so a developer can type in the gallery and watch the counter and layout. */
function JoinPin({ initial, error }: { initial: string; error?: string }) {
  const [pin, setPin] = useState(initial);
  return <JoinPinScreen pin={pin} onPinChange={setPin} onSubmit={noop} error={error} />;
}

function JoinNickname({ initial, error }: { initial: string; error?: string }) {
  const [nickname, setNickname] = useState(initial);
  return (
    <JoinNicknameScreen
      quizTitle={QUIZ_TITLE}
      nickname={nickname}
      onNicknameChange={setNickname}
      onSubmit={noop}
      onBack={noop}
      error={error}
    />
  );
}

/**
 * Half as wide again as the viewport, at every viewport. That is the size that hid the first
 * version of the scroll check: mobile emulation widens `window.innerWidth` to fit an over-wide
 * page (up to four times the device width), so a check against it passes here on the phones and
 * the tablet. If the check ever stops failing on this screen it has stopped checking anything.
 */
function OverflowProbe() {
  return (
    <main id="main" tabIndex={-1}>
      <h1>Overflow probe</h1>
      <div style={{ width: '150vw', height: 48, background: 'currentColor' }} />
    </main>
  );
}

const Play = ({ fixture }: { fixture: PlayFixtureId }) => (
  <PlayScreen state={PLAY_FIXTURES[fixture]} onAnswer={sent} onLeave={noop} onReload={noop} />
);

/**
 * id -> what to render. Keys must match `SCREENS` in manifest.ts exactly (the type checks
 * it). Screens render inside the app's own providers; nothing here touches the network.
 */
export const RENDERERS: Record<ScreenId, () => ReactNode> = {
  landing: () => <Landing />,

  'join-pin': () => <JoinPin initial="482913" />,
  'join-pin-error': () => (
    <JoinPin initial="482913" error="No game has that PIN. Check the number on the big screen." />
  ),
  'join-nickname': () => <JoinNickname initial="Riley" />,
  'join-nickname-error': () => (
    <JoinNickname
      initial="Riley"
      error="Someone in this game already has that nickname. Try a different one."
    />
  ),

  'play-lobby': () => <Play fixture="play-lobby" />,
  'play-get-ready': () => <Play fixture="play-get-ready" />,
  'play-answer-single': () => <Play fixture="play-answer-single" />,
  'play-answer-single-long': () => <Play fixture="play-answer-single-long" />,
  'play-answer-truefalse': () => <Play fixture="play-answer-truefalse" />,
  'play-answer-poll-6': () => <Play fixture="play-answer-poll-6" />,
  'play-answer-wordcloud': () => <Play fixture="play-answer-wordcloud" />,
  'play-answer-open': () => <Play fixture="play-answer-open" />,
  'play-answer-rating': () => <Play fixture="play-answer-rating" />,
  'play-submitted': () => <Play fixture="play-submitted" />,
  'play-times-up': () => <Play fixture="play-times-up" />,
  'play-reveal-correct': () => <Play fixture="play-reveal-correct" />,
  'play-reveal-incorrect': () => <Play fixture="play-reveal-incorrect" />,
  'play-reveal-unscored': () => <Play fixture="play-reveal-unscored" />,
  'play-reveal-no-answer': () => <Play fixture="play-reveal-no-answer" />,
  'play-leaderboard': () => <Play fixture="play-leaderboard" />,
  'play-ended': () => <Play fixture="play-ended" />,
  'play-reconnecting': () => <Play fixture="play-reconnecting" />,
  'play-kicked': () => <Play fixture="play-kicked" />,
  'play-session-over': () => <Play fixture="play-session-over" />,
  'play-out-of-date': () => <Play fixture="play-out-of-date" />,

  'present-lobby': () => <PresentFixtureScreen id="present-lobby" />,
  'present-lobby-400': () => <PresentFixtureScreen id="present-lobby-400" />,
  'present-get-ready': () => <PresentFixtureScreen id="present-get-ready" />,
  'present-question-open': () => <PresentFixtureScreen id="present-question-open" />,
  'present-question-image': () => <PresentFixtureScreen id="present-question-image" />,
  'present-question-long': () => <PresentFixtureScreen id="present-question-long" />,
  'present-reveal-single': () => <PresentFixtureScreen id="present-reveal-single" />,
  'present-reveal-truefalse': () => <PresentFixtureScreen id="present-reveal-truefalse" />,
  'present-reveal-poll': () => <PresentFixtureScreen id="present-reveal-poll" />,
  'present-wordcloud': () => <PresentFixtureScreen id="present-wordcloud" />,
  'present-open': () => <PresentFixtureScreen id="present-open" />,
  'present-rating': () => <PresentFixtureScreen id="present-rating" />,
  'present-leaderboard': () => <PresentFixtureScreen id="present-leaderboard" />,
  'present-podium': () => <PresentFixtureScreen id="present-podium" />,
  'present-ended-unscored': () => <PresentFixtureScreen id="present-ended-unscored" />,
  'present-help': () => <PresentFixtureScreen id="present-help" />,

  'host-login': () => <HostLoginFixture />,
  'host-dashboard': () => <HostDashboardFixture />,
  'host-live-lobby': () => <HostLiveFixture id="host-live-lobby" />,
  'host-live-question': () => <HostLiveFixture id="host-live-question" />,
  'host-live-moderation': () => <HostLiveFixture id="host-live-moderation" />,
  'host-live-reveal': () => <HostLiveFixture id="host-live-reveal" />,

  'edit-quiz': () => <EditorFixture fixture={{ kind: 'quiz' }} />,
  'edit-question-single': () => <EditorFixture fixture={{ kind: 'question', type: 'single' }} />,
  'edit-question-truefalse': () => (
    <EditorFixture fixture={{ kind: 'question', type: 'truefalse' }} />
  ),
  'edit-question-poll': () => <EditorFixture fixture={{ kind: 'question', type: 'poll' }} />,
  'edit-question-wordcloud': () => (
    <EditorFixture fixture={{ kind: 'question', type: 'wordcloud' }} />
  ),
  'edit-question-open': () => <EditorFixture fixture={{ kind: 'question', type: 'open' }} />,
  'edit-question-rating': () => <EditorFixture fixture={{ kind: 'question', type: 'rating' }} />,
  'edit-errors': () => <EditorFixture fixture={{ kind: 'errors' }} />,
  'edit-conflict': () => <EditorFixture fixture={{ kind: 'conflict' }} />,

  'test-overflow': () => <OverflowProbe />,
};
