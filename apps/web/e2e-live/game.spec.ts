import { readFile } from 'node:fs/promises';
import type { APIRequestContext } from '@playwright/test';
import { expect, shot, test } from './cast.ts';
import type { Actor } from './cast.ts';
import { expectNoAxeViolations } from './axe.ts';
import { parseCsv } from './csv.ts';
import { Control, apiToken, buildQuizInEditor, signIn } from './host.ts';
import {
  DELAY,
  MOVES,
  NICKNAMES,
  QUESTIONS,
  quizTitle,
  RIGS,
  SLOTS,
  isRight,
  isScored,
  limitSec,
} from './plan.ts';
import type { Move, Q, Slot } from './plan.ts';
import { Player } from './player.ts';
import type { RevealRead } from './player.ts';
import { Presenter } from './presenter.ts';
import { pointsFor, pointsRange, rankPlayers } from './scoring.ts';
import { ordinal } from '../src/state/format.ts';

const TOTAL = QUESTIONS.length;
const PLAYERS = SLOTS.length;

/** Starts work whose result is needed later, without leaving a rejection nobody is waiting on. */
function inBackground<T>(work: Promise<T>): () => Promise<T> {
  const settled = work.then(
    (value) => ({ ok: true as const, value }),
    (error: unknown) => ({ ok: false as const, error }),
  );
  return async () => {
    const result = await settled;
    if (!result.ok) throw result.error;
    return result.value;
  };
}

const COLUMNS = [
  'question_no',
  'question_type',
  'question',
  'nickname',
  'player_id',
  'answered',
  'response',
  'correct',
  'points',
  'streak_bonus',
  'response_time_ms',
  'moderation',
  'final_score',
  'final_rank',
] as const;
type CsvRow = Record<(typeof COLUMNS)[number], string>;
const CSV_HEADER = COLUMNS.join(',');

const withoutBom = (text: string) => text.replace(/^\uFEFF/, '');

/** What the editor saved, read back through the API the editor itself used. */
async function expectSavedQuiz(
  request: APIRequestContext,
  token: string,
  quizId: string,
  title: string,
): Promise<void> {
  const res = await request.get(`/api/quizzes/${quizId}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  expect(res.ok()).toBe(true);
  const quiz = (await res.json()) as {
    title: string;
    settings: { readSeconds: number };
    questions: Array<Record<string, unknown> & { options?: Array<{ id: string; text: string }> }>;
  };

  expect(quiz.title).toBe(title);
  expect(quiz.settings.readSeconds).toBe(0);
  expect(quiz.questions.map((q) => q.type)).toEqual([
    'single',
    'truefalse',
    'poll',
    'wordcloud',
    'single',
    'rating',
  ]);
  expect(quiz.questions.map((q) => q.prompt)).toEqual(QUESTIONS.map((q) => q.prompt));
  expect(quiz.questions.map((q) => q.timeLimitSec)).toEqual(QUESTIONS.map(limitSec));

  const [q1, q2, q3, q4, q5, q6] = quiz.questions;
  const single1 = QUESTIONS[0] as Extract<Q, { kind: 'single' }>;
  const single5 = QUESTIONS[4] as Extract<Q, { kind: 'single' }>;
  expect(q1?.options?.map((o) => o.text)).toEqual(single1.options);
  expect(q1?.correctOptionId).toBe(q1?.options?.[single1.correct]?.id);
  expect(q1?.points).toBe(1);
  expect(q2?.correct).toBe(false);
  expect(q3?.options?.map((o) => o.text)).toEqual(['TypeScript', 'Rust', 'Python']);
  expect(q4?.maxEntries).toBe(2);
  expect(q5?.options?.map((o) => o.text)).toEqual(single5.options);
  expect(q5?.correctOptionId).toBe(q5?.options?.[single5.correct]?.id);
  expect(q5?.points).toBe(2);
  expect(q6).toMatchObject({ max: 5, minLabel: 'Poor', maxLabel: 'Great' });
}

test('a host and five players play a whole quiz to the podium', async ({ cast, request }) => {
  const hostActor = await cast.open('host', { viewport: { width: 1366, height: 768 } });
  const presenterActor = await cast.open('presenter', { viewport: { width: 1920, height: 1080 } });
  const players = new Map<Slot, Player>();
  for (const slot of SLOTS) {
    const actor: Actor = await cast.open(slot, RIGS[slot]);
    players.set(slot, new Player(actor, slot, NICKNAMES[slot]));
  }
  const player = (slot: Slot) => players.get(slot) as Player;
  const control = new Control(hostActor.page);
  const presenter = new Presenter(presenterActor.page);

  const title = quizTitle(Date.now().toString(36));
  let pin = '';
  let sessionId = '';
  let token = '';

  // Points each player was told they gained, per question, and their running total.
  const gains = new Map<Slot, number[]>(SLOTS.map((s) => [s, []]));
  const totals = new Map<Slot, number>(SLOTS.map((s) => [s, 0]));
  const standingsNow = () =>
    rankPlayers(SLOTS.map((s) => ({ name: NICKNAMES[s], score: totals.get(s) as number })));
  const slotOf = (nickname: string) => SLOTS.find((s) => NICKNAMES[s] === nickname) as Slot;

  // ---------------------------------------------------------------------------------------
  await test.step('1. Host setup: sign in, build the quiz in the editor, start a session', async () => {
    await signIn(hostActor.page, '/host');
    await expect(
      hostActor.page.getByRole('main').getByRole('link', { name: 'New quiz' }),
    ).toBeVisible();

    const quizId = await test.step('build and save the quiz in the editor', async () => {
      const id = await buildQuizInEditor(hostActor.page, title);
      await shot(hostActor.page, 'host-editor-saved');
      return id;
    });
    await test.step('the server holds what the editor was told', async () => {
      token = await apiToken(request);
      await expectSavedQuiz(request, token, quizId, title);
    });

    await test.step('back on the dashboard, start a session', async () => {
      await hostActor.page
        .getByRole('navigation', { name: 'Host' })
        .getByRole('link', { name: 'Quizzes' })
        .click();
      // Other specs may have left quizzes on the dashboard; this one is found by its title.
      const card = hostActor.page
        .getByRole('listitem')
        .filter({ has: hostActor.page.getByRole('heading', { name: title }) });
      await expect(card.getByText('6 questions')).toBeVisible();
      await shot(hostActor.page, 'host-dashboard');
      await card.getByRole('button', { name: 'Start session' }).click();
      await hostActor.page.waitForURL(/\/host\/live\?s=/);
      sessionId = control.sessionId();
      pin = await control.pin();
      expect(pin).toMatch(/^[1-9]\d{5}$/);
      await control.expectPhase('lobby');
    });

    await test.step('open the presenter in its own window', async () => {
      await signIn(presenterActor.page, `/present?s=${sessionId}`);
      await expect(presenterActor.page.getByTestId('pin')).toBeVisible();
      expect(await presenter.pin()).toBe(pin);
      // The host's own "Open presenter" button opens the same screen, already signed in.
      const [popup] = await Promise.all([
        hostActor.context.waitForEvent('page'),
        hostActor.page.getByRole('button', { name: 'Open presenter' }).click(),
      ]);
      await expect(popup.getByTestId('pin')).toBeVisible();
      expect((await popup.getByTestId('pin').innerText()).replace(/\s/g, '')).toBe(pin);
      expect(new URL(popup.url()).searchParams.get('s')).toBe(sessionId);
      await popup.close();
    });
  });

  // ---------------------------------------------------------------------------------------
  await test.step('2. Players join: by link and by typing the PIN', async () => {
    await test.step('one player first tries a nickname that is taken', async () => {
      const first = player('P1');
      await first.openJoin(pin, RIGS.P1.join);
      await first.submitNickname(first.nickname);
      await first.expectJoined();

      const second = player('P2');
      await second.openJoin(pin, RIGS.P2.join);
      // Same letters, another case: the server treats the two as one nickname.
      await second.submitNickname(first.nickname.toUpperCase());
      await expect(second.page.getByRole('alert')).toContainText(/already|taken/i);
      await expect(second.page.locator('input[name="nickname"]')).toBeVisible();
      expect(second.page.url()).not.toContain('/play');
      await shot(second.page, 'join-nickname-taken');
      await second.submitNickname(second.nickname);
      await second.expectJoined();
    });

    for (const slot of ['P3', 'P4', 'P5'] as const) {
      const p = player(slot);
      await p.openJoin(pin, RIGS[slot].join);
      await p.submitNickname(p.nickname);
      await p.expectJoined();
    }

    await test.step('the projector lobby lists all five, and so does the host', async () => {
      await expect(presenterActor.page.getByTestId('player-count')).toHaveText(
        `${PLAYERS} players`,
      );
      expect((await presenter.lobbyNames()).sort()).toEqual(SLOTS.map((s) => NICKNAMES[s]).sort());
      // The roster's summary line, and the chip in the header. The chip once read the
      // snapshot's roster, which is empty in the lobby, and said "0 players".
      await expect(
        hostActor.page.getByText(`${PLAYERS} players, ${PLAYERS} connected`, { exact: true }),
      ).toBeVisible();
      await expect(
        hostActor.page.getByRole('listitem').filter({ hasText: /^\d+ players?$/ }),
      ).toHaveText(`${PLAYERS} players`);
      await expectNoAxeViolations(presenterActor.page, 'the live presenter lobby');
      await shot(presenterActor.page, 'lobby');
      await shot(hostActor.page, 'host-lobby');
      for (const slot of SLOTS) await shot(player(slot).page, `${slot}-lobby`);
    });
  });

  // ---------------------------------------------------------------------------------------
  await test.step('3. Game: six questions, answered as planned', async () => {
    for (const [i, q] of QUESTIONS.entries()) {
      const n = i + 1;
      // Single choice and true/false show their options until the reveal; the rest show charts.
      const optionCards = q.kind === 'single' ? q.options.length : q.kind === 'truefalse' ? 2 : 0;
      await test.step(`Q${n} (${q.kind}): open, answers, close, reveal`, async () => {
        // The first question starts from the presenter's keyboard, the rest from the host.
        if (i === 0) await presenter.pressSpace();

        // --- open ------------------------------------------------------------------------
        await presenter.expectPrompt(q.prompt);
        for (const slot of SLOTS) await player(slot).expectQuestion(q, i, TOTAL);
        await control.expectPhase('question');
        await presenter.expectAnswered(0, PLAYERS);
        await presenter.expectNoAnswerMarker(optionCards);
        // From here to the reveal every change to the projector's DOM is checked as it happens.
        await presenter.watchForLeaks();
        await shot(presenterActor.page, `q${n}-open`);

        // --- answers ---------------------------------------------------------------------
        const moveOf = (slot: Slot): Move => MOVES[slot][i] as Move;

        // Things that happen on the side while the players answer.
        const seesAnswers = inBackground(presenter.expectAnsweredAtLeast(3, PLAYERS));
        // The live question on the projector is scanned while Q1 runs.
        const scanQuestion =
          i === 0
            ? inBackground(
                expectNoAxeViolations(presenterActor.page, 'a live question on the presenter'),
              )
            : null;
        // The poll is scanned three ways: the projector and the host with votes in, and P1's
        // 320-wide answering screen. P4 answers last, so the poll is still open for all three.
        const scanPoll =
          q.kind === 'poll'
            ? inBackground(
                (async () => {
                  await presenter.expectAnsweredAtLeast(3, PLAYERS);
                  await Promise.all([
                    expectNoAxeViolations(presenterActor.page, 'the live poll on the presenter'),
                    expectNoAxeViolations(hostActor.page, 'the host control during a question'),
                  ]);
                  await control.expectPhase('question');
                })(),
              )
            : null;

        const play = async (slot: Slot) => {
          const p = player(slot);
          await p.expectOptionsOpen(q);
          if (slot === 'P1' && q.kind === 'poll') {
            await expectNoAxeViolations(p.page, 'the phone answering screen at 320x568');
          }
          if (i === 1 && slot === 'P2') await reloadMidQuestion(p, q, i);
          await p.waitSecondsIn(q, DELAY[slot]);
          if (slot === 'P4' && scanPoll) await scanPoll();
          await p.answer(q, moveOf(slot));
        };
        // P1, P2, P3 and P4 start at once, each after its own wait; P5 starts once P1's answer
        // has been accepted, so it always answers after P1.
        const p1 = inBackground(play('P1'));
        const rest = inBackground(
          Promise.all([play('P2'), play('P3'), play('P4'), p1().then(() => play('P5'))]),
        );
        await p1();
        await rest();
        await seesAnswers();
        if (q.kind === 'wordcloud') await expectLiveWords(presenter);
        if (scanQuestion) await scanQuestion();

        // --- close -----------------------------------------------------------------------
        if (q.kind === 'wordcloud') {
          // Two entries are allowed each, so "everyone has answered" does not end it: the host does.
          await control.next('End question');
        }
        // Q1 has a player who never answers, so only its 10 s timer can end it; the others end
        // when the last answer arrives. No host press is involved in either.
        await presenter.expectReveal(i, TOTAL);
        expect(
          await presenter.stopWatchingForLeaks(),
          `the presenter showed the answer before the reveal of Q${n}`,
        ).toEqual([]);
        await control.expectPhase('reveal');

        // --- reveal ----------------------------------------------------------------------
        const answeredCount = SLOTS.filter((s) => !('skip' in moveOf(s))).length;
        await expectPresenterReveal(presenter, q, i, answeredCount);
        if (i === 0)
          await expectNoAxeViolations(presenterActor.page, 'a live reveal on the presenter');
        await shot(presenterActor.page, `q${n}-reveal`);

        const reads = new Map<Slot, RevealRead>();
        for (const slot of SLOTS) reads.set(slot, await player(slot).readReveal());
        await shot(player('P1').page, `q${n}-reveal-P1`);
        // What each phone was told first, so that the standings below see everybody's points.
        for (const slot of SLOTS) {
          const read = reads.get(slot) as RevealRead;
          const g = gains.get(slot) as number[];
          expect(g).toHaveLength(i);
          g.push(read.gained);
          totals.set(slot, (totals.get(slot) as number) + read.gained);
        }
        const ranks = standingsNow();
        for (const slot of SLOTS) {
          const read = reads.get(slot) as RevealRead;
          expectRevealMatchesPlan(slot, q, moveOf(slot), read);
          if (isScored(q)) {
            expect(read.total, `${slot}'s total after Q${n}`).toBe(totals.get(slot));
            expect(read.place, `${slot}'s place after Q${n}`).toBe(
              ranks.find((r) => r.name === NICKNAMES[slot])?.rank,
            );
          }
          await expect
            .poll(() => player(slot).headerScore(), {
              message: `${slot}'s score strip after Q${n}`,
            })
            .toBe(totals.get(slot));
        }
        if (isScored(q)) {
          await expectPointsShape(q, i, gains);
          await expect(hostActor.page.getByText('Correct answer', { exact: true })).toHaveCount(1);
        }

        // --- leaderboard -----------------------------------------------------------------
        if (isScored(q)) {
          await control.next('Leaderboard');
          await control.expectPhase('leaderboard');
          await expectLeaderboard(presenter, i, standingsNow(), gains);
          await shot(presenterActor.page, `q${n}-leaderboard`);
          for (const slot of SLOTS) await expectPhoneStanding(player(slot), standingsNow(), i);
        }

        // --- next ------------------------------------------------------------------------
        if (i === TOTAL - 1) return;
        if (i === 0) {
          // Mid-game the presenter's keyboard moves on, too.
          await presenter.pressSpace();
        } else {
          await control.next('Next question');
        }
      });
    }
  });

  // ---------------------------------------------------------------------------------------
  await test.step('4. End: the podium and every player’s place', async () => {
    await control.next('Finish');
    await control.expectPhase('ended');
    const expected = standingsNow();
    // The plan fixes this order; the scores only have to agree with it, tie rules included.
    expect(expected.map((r) => r.name)).toEqual(['Alice', 'Eve', 'Bobby', 'Dara', 'Cleo']);
    expect(expected.map((r) => r.rank)).toEqual([1, 2, 3, 4, 5]);

    await expect(presenterActor.page.getByTestId('podium')).toBeVisible();
    const podium = await presenter.podium();
    expect(podium.map((p) => p.nickname)).toEqual(['Alice', 'Eve', 'Bobby']);
    expect(podium.map((p) => p.rank)).toEqual([1, 2, 3]);
    expect(podium.map((p) => p.score)).toEqual(expected.slice(0, 3).map((r) => r.score));
    await shot(presenterActor.page, 'podium');

    for (const r of expected) {
      const slot = slotOf(r.name);
      const p = player(slot);
      await expect(p.page.getByRole('heading', { level: 1 })).toHaveText(
        `You finished ${ordinal(r.rank)}`,
      );
      const main = await p.page.getByRole('main').innerText();
      expect(main).toContain(`${r.score.toLocaleString('en-US')} point`);
      const scoredRight = MOVES[slot].filter((m, i) => isRight(QUESTIONS[i] as Q, m)).length;
      expect(main).toContain(`${scoredRight} of 3 correct`);
      // The top three are on every phone, in order.
      const listed = await p.page
        .getByRole('main')
        .locator('ol > li')
        .evaluateAll((items) => items.map((li) => li.children[1]?.textContent?.trim()));
      expect(listed).toEqual(['Alice', 'Eve', 'Bobby']);
      await shot(p.page, `${slot}-final`);
    }
    await shot(hostActor.page, 'host-ended');
  });

  // ---------------------------------------------------------------------------------------
  await test.step('5. Export: the results CSV from the dashboard', async () => {
    await hostActor.page
      .getByRole('navigation', { name: 'Host' })
      .getByRole('link', { name: 'Quizzes' })
      .click();
    const [download] = await Promise.all([
      hostActor.page.waitForEvent('download'),
      hostActor.page.getByRole('button', { name: `Download results for ${title} as CSV` }).click(),
    ]);
    expect(download.suggestedFilename()).toBe(`zqhoot-results-${pin}.csv`);
    const savedBytes = await readFile(await download.path());
    // The saved file starts with a UTF-8 byte order mark, so that a spreadsheet reads nicknames
    // right. The bytes are checked: decoding them would hide the mark.
    expect([...savedBytes.subarray(0, 3)], 'the file starts with a byte order mark').toEqual([
      0xef, 0xbb, 0xbf,
    ]);
    const saved = savedBytes.toString('utf8');
    expect(saved.startsWith('\uFEFF\uFEFF'), 'there is only one mark').toBe(false);

    // What the server sends is what the dashboard should save. The mark is left out of this
    // comparison because the Lambda handler drops it on the way out (download-bom.spec.ts
    // tracks that); the dashboard puts it back when it saves.
    const served = await request.get(`/api/sessions/${sessionId}/results.csv`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(served.ok()).toBe(true);
    expect(served.headers()['content-type']).toContain('text/csv');
    const text = withoutBom(await served.text());
    expect(withoutBom(saved), 'the download is the file the server sent').toBe(text);
    expectResultsCsv(text, standingsNow(), gains);
  });

  expect(cast.pageErrors(), 'uncaught errors in any page').toEqual([]);
});

// ---------------------------------------------------------------------------------------------
// Assertions, kept out of the scenario so it reads as one.
// ---------------------------------------------------------------------------------------------

/**
 * P2 reloads after Q2 has opened and before answering. The phone must resume from what the
 * browser stored, not join again, and must land on the same open question with its score kept.
 */
async function reloadMidQuestion(p: Player, q: Q, index: number): Promise<void> {
  const scoreBefore = await p.headerScore();
  const { sent, visited } = await p.reload();
  await p.expectQuestion(q, index, TOTAL);
  await p.expectOptionsOpen(q);
  expect(
    sent.some((f) => f.includes('"type":"resume"')),
    'a resume was sent',
  ).toBe(true);
  expect(
    sent.some((f) => f.includes('"type":"join"')),
    'no join was sent',
  ).toBe(false);
  expect(
    visited.some((u) => u.includes('/join')),
    'the join page was never shown',
  ).toBe(false);
  expect(p.page.url()).toContain('/play?s=');
  await expect(p.header().getByText(p.nickname, { exact: true })).toBeVisible();
  expect(await p.headerScore(), 'the score survives the reload').toBe(scoreBefore);
  expect(scoreBefore).toBeGreaterThan(0);
}

/** Word cloud while it is open: "Fun" and "FUN" are one word with two votes. */
async function expectLiveWords(presenter: Presenter): Promise<void> {
  await expect
    .poll(async () => (await presenter.chartTable()).rows.map((r) => r.join('=')).sort())
    // P4's word may or may not be in yet.
    .toEqual(expect.arrayContaining(['fast=1', 'fun=2', 'smooth=1', 'tense=1']));
  const drawn = (await presenter.cloudWords()).map((w) => w.toLowerCase());
  expect(
    drawn.filter((w) => w === 'fun'),
    'the word is drawn once',
  ).toHaveLength(1);
}

async function expectPresenterReveal(
  presenter: Presenter,
  q: Q,
  index: number,
  answered: number,
): Promise<void> {
  await expect(presenter.page.getByText(`${answered} of ${PLAYERS} answered`)).toBeVisible();

  if (q.kind === 'single' || q.kind === 'truefalse' || q.kind === 'poll') {
    const labels = q.kind === 'truefalse' ? ['True', 'False'] : q.options;
    const votes = labels.map(
      (_, option) =>
        SLOTS.filter((s) => {
          const m = MOVES[s][index] as Move;
          return 'option' in m
            ? m.option === option
            : 'bool' in m
              ? m.bool === (option === 0)
              : false;
        }).length,
    );
    const bars = await presenter.bars();
    expect(bars.map((b) => b.label)).toEqual([...labels]);
    expect(
      bars.map((b) => b.count),
      'counts on the projector',
    ).toEqual(votes);
    expect(bars.map((b) => b.percent)).toEqual(votes.map((v) => Math.round((v / answered) * 100)));

    if (q.kind === 'poll') {
      expect(
        bars.some((b) => b.marked),
        'a poll has no right answer',
      ).toBe(false);
      const table = await presenter.chartTable();
      expect(table.head).not.toContain('Correct');
    } else {
      const right = q.kind === 'single' ? q.correct : q.correct ? 0 : 1;
      expect(
        bars.map((b) => b.marked),
        'the Correct badge is on the right row only',
      ).toEqual(labels.map((_, k) => k === right));
      const table = await presenter.chartTable();
      expect(table.head).toEqual(['Answer', 'Text', 'Count', 'Percent', 'Correct']);
      expect(table.rows.map((r) => r[4])).toEqual(
        labels.map((_, k) => (k === right ? 'Yes' : 'No')),
      );
      expect(table.rows.map((r) => Number(r[2]))).toEqual(votes);
      await presenter.expectAnswerMarkerPresent();
    }
  } else if (q.kind === 'wordcloud') {
    const table = await presenter.chartTable();
    expect(table.head).toEqual(['Word', 'Votes']);
    expect(table.rows.map((r) => `${r[0]}=${r[1]}`)).toEqual([
      'fun=2',
      'fast=1',
      'smooth=1',
      'tense=1',
      'tricky=1',
    ]);
    const drawn = (await presenter.cloudWords()).map((w) => w.toLowerCase());
    expect(drawn.filter((w) => w === 'fun')).toHaveLength(1);
  } else {
    const table = await presenter.chartTable();
    expect(table.head).toEqual(['Rating', 'Count']);
    expect(table.rows.map((r) => Number(r[1]))).toEqual([0, 0, 1, 2, 2]);
    // 5, 4, 3, 4, 5: mean 4.2.
    expect(await presenter.ratingAverageText()).toBe(`Average 4.2 of ${q.max}`);
  }
}

/** The headline, the points and the correct answer each phone shows, against the plan. */
function expectRevealMatchesPlan(slot: Slot, q: Q, move: Move, read: RevealRead): void {
  const who = `${slot} on ${q.kind}`;
  if (!isScored(q)) {
    expect(read.variant, who).toBe('unscored');
    expect(read.gained, who).toBe(0);
    return;
  }
  if ('skip' in move) {
    expect(read.variant, who).toBe('no-answer');
    expect(read.gained, who).toBe(0);
  } else if (isRight(q, move)) {
    expect(read.variant, who).toBe('correct');
    const { min, max } = pointsRange(q.multiplier);
    expect(read.gained, `${who} is within the ADR-0005 range`).toBeGreaterThanOrEqual(min);
    expect(read.gained, `${who} is within the ADR-0005 range`).toBeLessThanOrEqual(max);
  } else {
    expect(read.variant, who).toBe('incorrect');
    expect(read.gained, who).toBe(0);
  }
  // Anyone who was not right is shown the answer they missed; the others are not.
  const answer =
    q.kind === 'single' ? (q.options[q.correct] as string) : q.correct ? 'True' : 'False';
  if (read.variant === 'correct') expect(read.text).not.toContain(answer);
  else expect(read.text, `${who} is shown the right answer`).toContain(answer);
}

/**
 * What the delays in the plan must have done to the points. P5 answered at least one second in,
 * P4 at least three, so neither can hold more than the formula gives at that moment; the two fast
 * players hold more than that, and double points are worth more than a full standard answer.
 */
async function expectPointsShape(
  q: Extract<Q, { kind: 'single' | 'truefalse' }>,
  index: number,
  gains: Map<Slot, number[]>,
): Promise<void> {
  const g = (slot: Slot) => (gains.get(slot) as number[])[index] as number;
  const at = (ms: number) =>
    pointsFor({ correct: true, elapsedMs: ms, limitMs: 10_000, multiplier: q.multiplier });
  const right = (slot: Slot) => isRight(q, MOVES[slot][index] as Move);
  if (right('P5')) expect(g('P5'), 'P5 answered at least 1 s in').toBeLessThanOrEqual(at(1000));
  if (right('P4')) expect(g('P4'), 'P4 answered at least 3 s in').toBeLessThanOrEqual(at(3000));
  // P5 answers after P1's answer was accepted, so it never earns more.
  expect(g('P5')).toBeLessThanOrEqual(g('P1'));
  if (q.multiplier === 2) {
    expect(g('P1'), 'double points beat a full standard answer').toBeGreaterThan(1000);
  }
}

async function expectLeaderboard(
  presenter: Presenter,
  index: number,
  ranked: ReturnType<typeof rankPlayers>,
  gains: Map<Slot, number[]>,
): Promise<void> {
  await expect(presenter.page.getByTestId('leaderboard')).toBeVisible();
  const rows = await presenter.leaderboard();
  expect(rows.map((r) => r.nickname)).toEqual(ranked.map((r) => r.name));
  expect(rows.map((r) => r.rank)).toEqual(ranked.map((r) => ordinal(r.rank)));
  expect(rows.map((r) => r.score)).toEqual(ranked.map((r) => r.score));
  expect(rows.map((r) => r.delta)).toEqual(
    ranked.map(
      (r) => (gains.get(SLOTS.find((s) => NICKNAMES[s] === r.name) as Slot) as number[])[index],
    ),
  );
  if (index === 0) {
    // Nobody who was wrong or silent has a point yet, and they share a rank (ADR-0005).
    expect(rows.filter((r) => r.score === 0).map((r) => [r.nickname, r.rank])).toEqual([
      ['Cleo', '4th'],
      ['Dara', '4th'],
    ]);
  }
}

async function expectPhoneStanding(
  p: Player,
  ranked: ReturnType<typeof rankPlayers>,
  index: number,
): Promise<void> {
  const mine = ranked.find((r) => r.name === p.nickname) as { rank: number; score: number };
  await expect(
    p.page.getByRole('heading', { level: 1 }),
    `${p.nickname}'s standing after Q${index + 1}`,
  ).toHaveText(new RegExp(`^You're ${ordinal(mine.rank)}\\b`));
}

/** Rows of the results CSV against the plan, the ADR-0005 formula and the podium. */
function expectResultsCsv(
  text: string,
  ranked: ReturnType<typeof rankPlayers>,
  gains: Map<Slot, number[]>,
): void {
  expect(text.endsWith('\r\n')).toBe(true);
  const rows = parseCsv(text);
  expect(rows[0]?.join(',')).toBe(CSV_HEADER);
  const header = rows[0] as string[];
  const data = rows
    .slice(1)
    .map((r) => Object.fromEntries(header.map((h, k) => [h, r[k] ?? ''])) as CsvRow);

  // Five players on each of five questions, and one row per entry on the word cloud (1+1+1+1+2).
  expect(data).toHaveLength(5 * 5 + 6);

  const order = ranked.map((r) => r.name);
  const ids = new Map<string, string>();
  const rowsOf = (n: number) => data.filter((r) => r.question_no === String(n));

  for (const [i, q] of QUESTIONS.entries()) {
    const block = rowsOf(i + 1);
    expect(block.length, `rows of Q${i + 1}`).toBe(q.kind === 'wordcloud' ? 6 : 5);
    // Players are listed in final rank order inside each question.
    expect([...new Set(block.map((r) => r.nickname))]).toEqual(order);

    for (const row of block) {
      const slot = SLOTS.find((s) => NICKNAMES[s] === row.nickname) as Slot;
      const move = MOVES[slot][i] as Move;
      expect(row.question, `Q${i + 1} text`).toBe(q.prompt);
      expect(row.question_type).toBe(q.kind);
      expect(row.player_id).not.toBe('');
      expect(ids.get(row.nickname) ?? row.player_id, 'one id per player').toBe(row.player_id);
      ids.set(row.nickname, row.player_id);
      expect(row.streak_bonus).toBe('0');

      const skipped = 'skip' in move;
      expect(row.answered, `${slot} on Q${i + 1}`).toBe(skipped ? 'no' : 'yes');
      if (skipped) {
        expect([row.response, row.response_time_ms, row.correct, row.points]).toEqual([
          '',
          '',
          'no',
          '0',
        ]);
        continue;
      }
      const elapsed = Number(row.response_time_ms);
      expect(Number.isInteger(elapsed), `${slot} Q${i + 1} response time`).toBe(true);
      expect(elapsed).toBeGreaterThanOrEqual(0);
      expect(elapsed).toBeLessThanOrEqual(limitSec(q) * 1000);
      // The delays of the plan, as the server measured them.
      const delayMs = (DELAY[slot] ?? 0) * 1000;
      expect(elapsed, `${slot} answered after its ${delayMs} ms wait`).toBeGreaterThanOrEqual(
        delayMs,
      );

      if (isScored(q)) {
        const right = isRight(q, move);
        expect(row.correct, `${slot} on Q${i + 1}`).toBe(right ? 'yes' : 'no');
        const expected = pointsFor({
          correct: right,
          elapsedMs: elapsed,
          limitMs: 10_000,
          multiplier: q.multiplier,
        });
        expect(Number(row.points), `${slot}'s points on Q${i + 1} by the ADR-0005 formula`).toBe(
          expected,
        );
        expect(Number(row.points), 'the phone showed the same').toBe(
          (gains.get(slot) as number[])[i],
        );
      } else {
        expect(row.correct).toBe('');
        expect(row.points).toBe('0');
      }
      expect(row.moderation).toBe(q.kind === 'wordcloud' ? 'visible' : '');
    }

    if (q.kind === 'single' || q.kind === 'poll') {
      const byNick = new Map(block.map((r) => [r.nickname, r.response]));
      for (const slot of SLOTS) {
        const move = MOVES[slot][i] as Move;
        if ('option' in move) expect(byNick.get(NICKNAMES[slot])).toBe(q.options[move.option]);
      }
    } else if (q.kind === 'truefalse') {
      for (const slot of SLOTS) {
        const move = MOVES[slot][i] as { bool: boolean };
        const row = block.find((r) => r.nickname === NICKNAMES[slot]);
        expect(row?.response).toBe(move.bool ? 'True' : 'False');
      }
    } else if (q.kind === 'rating') {
      for (const slot of SLOTS) {
        const move = MOVES[slot][i] as { rating: number };
        expect(block.find((r) => r.nickname === NICKNAMES[slot])?.response).toBe(
          String(move.rating),
        );
      }
    } else {
      // Entries are lower-cased, so "Fun" and "FUN" are the same word.
      expect(block.map((r) => `${r.nickname}:${r.response}`)).toEqual([
        'Alice:fun',
        'Eve:smooth',
        'Eve:tense',
        'Bobby:fast',
        'Dara:tricky',
        'Cleo:fun',
      ]);
    }
  }

  // Final columns agree with the podium on every row.
  for (const row of data) {
    const r = ranked.find((x) => x.name === row.nickname) as { score: number; rank: number };
    expect(Number(row.final_score)).toBe(r.score);
    expect(Number(row.final_rank), `final_rank of ${row.nickname}`).toBe(r.rank);
  }
  // And the points add up to the final score.
  for (const slot of SLOTS) {
    const sum = data
      .filter((r) => r.nickname === NICKNAMES[slot])
      .reduce((total, r) => total + Number(r.points), 0);
    expect(sum, `${slot}'s points add up`).toBe(
      ranked.find((r) => r.name === NICKNAMES[slot])?.score,
    );
  }
}
