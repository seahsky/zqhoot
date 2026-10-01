import type { HostState } from '../../state/host.ts';
import {
  LEADERBOARD,
  LUNCH_RESULT,
  MERCURY_RESULT,
  OFFSITE_RESULT,
  PODIUM,
  RATING_RESULT,
  WALL_RESULT,
  WEATHER_RESULT,
  hostSnapshot,
  pollQ,
  questionSnapshot,
  ratingQ,
  revealSnapshot,
  roster,
  singleImageQ,
  singleLongQ,
  singleQ,
  trueFalseQ,
  wordCloudQ,
  openQ,
} from './hostSnapshots.ts';
import { hostStateOf, refusedStateOf, statsFor } from './hostState.ts';
import { DEMO_IMAGE_URL } from './images.ts';

export { HOST_FIXTURE_MESSAGES } from './hostState.ts';

export interface PresentFixture {
  state: HostState;
  /** The help overlay is open. */
  helpOpen?: boolean;
  /** Resolved URL of the question's picture. */
  imageUrl?: string;
}

/**
 * The presenter's screens. The question fixtures deliberately carry the correct answer (the host
 * snapshot always does) and a live distribution: test/gallery-fixtures.test.ts and the e2e
 * spec check that the room-facing screen shows neither. The counts are distinctive on purpose
 * (211, 88, 61, 17) so a leak cannot hide behind a common number.
 */
export const OPEN_QUESTION_COUNTS = {
  'option-mercury': 211,
  'option-venus': 88,
  'option-earth': 61,
  'option-mars': 17,
} as const;

const FULL_ROOM = roster(400);

const choiceStats = statsFor({
  type: 'single',
  answered: 377,
  totalPlayers: 400,
  counts: { ...OPEN_QUESTION_COUNTS },
});

export const PRESENT_FIXTURES = {
  'present-lobby': { state: hostStateOf(hostSnapshot({ roster: roster(22) })) },
  'present-lobby-400': { state: hostStateOf(hostSnapshot({ roster: FULL_ROOM })) },
  'present-get-ready': {
    state: hostStateOf(questionSnapshot(singleQ, -3_000, { roster: roster(22) })),
  },
  'present-question-open': {
    state: hostStateOf(questionSnapshot(singleQ, 6_000, { roster: FULL_ROOM }), choiceStats),
  },
  'present-question-image': {
    state: hostStateOf(
      questionSnapshot(singleImageQ, 9_000, { roster: roster(22) }),
      statsFor({ type: 'single', answered: 12, totalPlayers: 22, counts: {} }),
    ),
    imageUrl: DEMO_IMAGE_URL,
  },
  'present-question-long': {
    state: hostStateOf(
      questionSnapshot(singleLongQ, 12_000, { roster: roster(22) }),
      statsFor({ type: 'single', answered: 9, totalPlayers: 22, counts: {} }),
    ),
  },
  'present-reveal-single': { state: hostStateOf(revealSnapshot(singleQ, MERCURY_RESULT)) },
  'present-reveal-truefalse': { state: hostStateOf(revealSnapshot(trueFalseQ, WALL_RESULT)) },
  'present-reveal-poll': { state: hostStateOf(revealSnapshot(pollQ, LUNCH_RESULT)) },
  'present-wordcloud': { state: hostStateOf(revealSnapshot(wordCloudQ, WEATHER_RESULT)) },
  'present-open': { state: hostStateOf(revealSnapshot(openQ, OFFSITE_RESULT)) },
  'present-rating': { state: hostStateOf(revealSnapshot(ratingQ, RATING_RESULT)) },
  'present-leaderboard': {
    state: hostStateOf(
      hostSnapshot({ phase: 'leaderboard', questionIndex: 2, leaderboard: LEADERBOARD }),
    ),
  },
  'present-podium': {
    state: hostStateOf(hostSnapshot({ phase: 'ended', questionIndex: 9, podium: PODIUM })),
  },
  'present-ended-unscored': {
    state: hostStateOf(
      hostSnapshot({
        phase: 'ended',
        questionIndex: 4,
        totalQuestions: 5,
        hasScoredQuestions: false,
        podium: [],
      }),
    ),
  },
  'present-help': { state: hostStateOf(hostSnapshot({ roster: roster(22) })), helpOpen: true },
  'present-forbidden': { state: refusedStateOf('forbidden') },
} satisfies Record<string, PresentFixture>;

export type PresentFixtureId = keyof typeof PRESENT_FIXTURES;
