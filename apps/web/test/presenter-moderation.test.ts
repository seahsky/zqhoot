import { describe, expect, it } from 'vitest';
import { LIMITS } from '@zqhoot/protocol';
import type { HostStatsMsg, OpenResponseView, ServerMessage } from '@zqhoot/protocol';
import { NOW } from '../src/dev/fixtures/common.ts';
import { openQ, questionSnapshot } from '../src/dev/fixtures/hostSnapshots.ts';
import { IDLE_DRIVER, REWALK_MS, driverQuestionOf, driverStep } from '../src/state/driver.ts';
import type { DriverInput, DriverState } from '../src/state/driver.ts';
import { hostReducer, initialHostState } from '../src/state/host.ts';
import type { HostState } from '../src/state/host.ts';
import { presenterView, visibleNewestFirst } from '../src/state/presenterView.ts';

/**
 * The presenter and the control are separate connections: when the host moderates in the control
 * window the server sends the presenter nothing. Its only way to hear is to read the responses
 * again, and past one page a poller that keeps its last cursor never re-reads the first one.
 * This runs the driver and the reducer against a server that pages like the engine does.
 */

const TICK_MS = 250;
const PLAYERS = 200;
const TOTAL = 150;
/** Status changes made by the host, by position in the list. */
const HIDE_AT = 39;
const APPROVE_AT = 59;

/** 150 responses, oldest first; the ones a room may see are visible, #60 waits for approval. */
function makeResponses(): OpenResponseView[] {
  return Array.from({ length: TOTAL }, (_, i) => ({
    id: `player-${String(i + 1).padStart(4, '0')}-0`,
    nickname: `P${i + 1}`,
    text: `Idea ${i + 1}`,
    status: i === APPROVE_AT ? 'pending' : 'visible',
    receivedAt: NOW - 60_000 + i * 100,
  }));
}

/** Pages like `computeLiveStats`: responses strictly after the cursor, one page, and a cursor only if more wait. */
function fakeServer(responses: OpenResponseView[]) {
  const positionOf = (cursor: string | undefined) =>
    cursor === undefined ? 0 : responses.findIndex((r) => r.id === cursor) + 1;
  return (cmd: HostStatsMsg): ServerMessage => {
    const from = positionOf(cmd.after);
    const page = responses.slice(from, from + LIMITS.statsResponsesPage);
    const more = from + page.length < responses.length;
    return {
      type: 'stats',
      ts: NOW,
      questionIndex: cmd.questionIndex,
      stats: {
        type: 'open',
        answered: 120,
        totalPlayers: PLAYERS,
        responses: page.map((r) => ({ ...r })),
        cursor: more ? (page.at(-1)?.id ?? null) : null,
      },
    };
  };
}

/** A presenter connection, stepped in quarter seconds, with every request answered at once. */
function presenter(responses: OpenResponseView[]) {
  const answer = fakeServer(responses);
  let host: HostState = hostReducer(initialHostState('open'), {
    type: 'message',
    msg: { type: 'welcome', ts: NOW, role: 'host', snapshot: questionSnapshot(openQ, 5_000) },
  });
  const snap = host.snapshot;
  if (!snap?.question) throw new Error('fixture has no question');
  let driver: DriverState = driverStep(
    IDLE_DRIVER,
    {
      type: 'sync',
      question: driverQuestionOf(
        snap.question.question,
        snap.questionIndex,
        snap.question.openAt,
        snap.question.deadline,
      ),
    },
    NOW,
  ).state;
  const requests: HostStatsMsg[] = [];

  const feed = (input: DriverInput, now: number): void => {
    const r = driverStep(driver, input, now);
    driver = r.state;
    for (const cmd of r.commands) {
      if (cmd.type !== 'host.stats') throw new Error(`unexpected ${cmd.type}`);
      requests.push(cmd);
      const reply = answer(cmd);
      host = hostReducer(host, { type: 'message', msg: reply });
      if (reply.type === 'stats' && reply.stats.type === 'open') {
        feed(
          {
            type: 'stats',
            questionIndex: reply.questionIndex,
            answered: reply.stats.answered,
            totalPlayers: reply.stats.totalPlayers,
            cursor: reply.stats.cursor,
          },
          now,
        );
      }
    }
  };

  let now = NOW;
  return {
    requests,
    /** Runs the clock forward, one driver tick per quarter second. */
    advance(ms: number): void {
      for (let end = now + ms; now < end;) {
        now += TICK_MS;
        feed({ type: 'tick' }, now);
      }
    },
    /** What the room sees of the live wall, newest first. */
    onScreen: () => visibleNewestFirst(host.live?.responses ?? []).map((r) => r.id),
    view: () => presenterView(host, now),
    get held(): number {
      return host.live?.responses.length ?? 0;
    },
  };
}

const idOf = (i: number) => `player-${String(i + 1).padStart(4, '0')}-0`;

describe('presenter and moderation past one page of responses', () => {
  it('reads every page at first, and holds all responses', () => {
    const p = presenter(makeResponses());
    p.advance(2_000);
    expect(p.held).toBe(TOTAL);
    expect(p.onScreen()).toHaveLength(TOTAL - 1);
    expect(p.onScreen()).not.toContain(idOf(APPROVE_AT));
  });

  it('takes a response the host hides off the wall within a re-walk', () => {
    const responses = makeResponses();
    const p = presenter(responses);
    p.advance(5_000);
    expect(p.onScreen()).toContain(idOf(HIDE_AT));

    // The host hides #40 in the control window; the presenter is told nothing.
    (responses[HIDE_AT] as OpenResponseView).status = 'hidden';
    p.advance(REWALK_MS + 2_000);
    expect(p.onScreen()).not.toContain(idOf(HIDE_AT));
    const view = p.view();
    expect(view.screen).toBe('question');
    if (view.screen === 'question' && view.live?.kind === 'wall') {
      expect(view.live.responses.map((r) => r.id)).not.toContain(idOf(HIDE_AT));
    }
  });

  it('shows a response the host approves late', () => {
    const responses = makeResponses();
    const p = presenter(responses);
    p.advance(5_000);
    expect(p.onScreen()).not.toContain(idOf(APPROVE_AT));

    (responses[APPROVE_AT] as OpenResponseView).status = 'visible';
    p.advance(REWALK_MS + 2_000);
    expect(p.onScreen()).toContain(idOf(APPROVE_AT));
  });

  it('still picks up new responses, and asks for the first page only now and then', () => {
    const responses = makeResponses();
    const p = presenter(responses);
    p.advance(2_000);
    responses.push({
      id: idOf(TOTAL),
      nickname: 'Late',
      text: 'A late idea',
      status: 'visible',
      receivedAt: NOW,
    });
    p.advance(1_500);
    expect(p.onScreen()[0]).toBe(idOf(TOTAL));

    // Over a minute: a re-walk costs two requests, so most polls are single tail requests.
    const before = p.requests.length;
    p.advance(60_000);
    const seen = p.requests.slice(before);
    const fromStart = seen.filter((r) => r.after === undefined).length;
    expect(fromStart).toBeGreaterThan(60_000 / (REWALK_MS + 2_000) - 1);
    expect(fromStart).toBeLessThan(seen.length / 2);
  });

  it('a list that fits one page is read from the first page every time', () => {
    const responses = makeResponses().slice(0, 40);
    const p = presenter(responses);
    p.advance(10_000);
    expect(p.requests.length).toBeGreaterThan(5);
    expect(p.requests.every((r) => r.after === undefined)).toBe(true);
  });
});
