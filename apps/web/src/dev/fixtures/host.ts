import type { QuizSummary, SessionSummary } from '@zqhoot/protocol';
import type { HostState } from '../../state/host.ts';
import { NOW } from './common.ts';
import {
  MERCURY_RESULT,
  PLAYERS,
  QUIZ_ID,
  QUIZ_QUESTIONS,
  hostRoster,
  hostSnapshot,
  openQ,
  openResponses,
  questionSnapshot,
  quizIndexOf,
  revealSnapshot,
  singleQ,
} from './hostSnapshots.ts';
import { hostStateOf, refusedStateOf, statsFor } from './hostState.ts';

export { HOST_FIXTURE_MESSAGES } from './hostState.ts';

/**
 * The host's own screens: the live control in four phases, all of one 22-player game of the
 * quiz the editor shows. Each question sits at its place in that quiz, so "Question 5 of 6" is
 * the open-ended one here and in the editor.
 */
const SINGLE_AT = quizIndexOf(singleQ);
const OPEN_AT = quizIndexOf(openQ);

export const HOST_LIVE_FIXTURES = {
  'host-live-lobby': hostStateOf(hostSnapshot({ roster: hostRoster([3, 7]) })),
  'host-live-question': hostStateOf(
    questionSnapshot(singleQ, 8_000, { roster: hostRoster() }, SINGLE_AT),
    statsFor(
      {
        type: 'single',
        answered: 14,
        totalPlayers: PLAYERS,
        counts: { 'option-mercury': 7, 'option-venus': 4, 'option-earth': 2, 'option-mars': 1 },
      },
      SINGLE_AT,
    ),
  ),
  'host-live-moderation': hostStateOf(
    questionSnapshot(openQ, 30_000, { roster: hostRoster() }, OPEN_AT),
    statsFor(
      {
        type: 'open',
        answered: 10,
        totalPlayers: PLAYERS,
        responses: openResponses(),
        cursor: null,
      },
      OPEN_AT,
    ),
  ),
  'host-live-reveal': hostStateOf(
    revealSnapshot(singleQ, MERCURY_RESULT, { roster: hostRoster() }, SINGLE_AT),
  ),
  // The session is another account's: no snapshot, and the page has stopped.
  'host-live-forbidden': refusedStateOf('forbidden'),
} satisfies Record<string, HostState>;

export type HostLiveFixtureId = keyof typeof HOST_LIVE_FIXTURES;

const DAY = 86_400_000;

export const DASHBOARD_QUIZZES: QuizSummary[] = [
  {
    id: QUIZ_ID,
    title: 'Friday night trivia',
    questionCount: QUIZ_QUESTIONS.length,
    updatedAt: NOW - 2 * DAY,
    version: 4,
  },
  {
    id: 'quiz-demo-0002',
    title: 'Onboarding week: what did we learn?',
    questionCount: 6,
    updatedAt: NOW - 9 * DAY,
    version: 2,
  },
  {
    id: 'quiz-demo-0003',
    title: 'Product retro, Q3',
    questionCount: 1,
    updatedAt: NOW - 30 * DAY,
    version: 1,
  },
];

export const DASHBOARD_SESSIONS: SessionSummary[] = [
  {
    sessionId: 'session-demo-01',
    pin: '482915',
    quizId: QUIZ_ID,
    quizTitle: 'Friday night trivia',
    phase: 'question',
    createdAt: NOW - 3_600_000,
    expiresAt: NOW + 20 * 3_600_000,
  },
  {
    sessionId: 'session-demo-02',
    pin: '730164',
    quizId: 'quiz-demo-0002',
    quizTitle: 'Onboarding week: what did we learn?',
    phase: 'ended',
    createdAt: NOW - 3 * DAY,
    expiresAt: NOW + DAY,
  },
];
