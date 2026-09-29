import type { CSSProperties } from 'react';
import { groupDigits } from '../../state/charts.ts';
import { ordinal } from '../../state/format.ts';
import type { HostEnd } from '../../state/host.ts';
import type { PresenterView, StandingRow } from '../../state/presenterView.ts';
import { VisuallyHidden } from '../../ui/VisuallyHidden.tsx';
import s from './Present.module.css';

const style = (vars: Record<string, string | number>) => vars as CSSProperties;

/**
 * How many places each row has to travel to get from the last board to this one: positive is
 * down. Rows that were not on the last board rise from just below it. Only when there is a
 * last board (and the person allows motion) does anything move.
 */
export function movesFor(
  entries: readonly StandingRow[],
  previous: ReadonlyMap<string, number> | undefined,
): Map<string, number> {
  const moves = new Map<string, number>();
  if (!previous || previous.size === 0) return moves;
  entries.forEach((e, i) => {
    const before = previous.get(e.playerId);
    const from = before === undefined ? entries.length + 1 : before;
    if (from !== i) moves.set(e.playerId, from - i);
  });
  return moves;
}

type LeaderboardView = Extract<PresenterView, { screen: 'leaderboard' }>;

/** Top five: rank, nickname, score and the points gained on the last question. */
export function LeaderboardView({
  view,
  previous,
  animate,
}: {
  view: LeaderboardView;
  /** playerId -> row index on the board before this one. */
  previous?: ReadonlyMap<string, number>;
  animate: boolean;
}) {
  const moves = animate ? movesFor(view.entries, previous) : new Map<string, number>();
  return (
    <section className={s.screen} aria-labelledby="board-title">
      <header className={s.headText}>
        <p className={s.meta}>
          After question {view.index + 1} of {view.total}
        </p>
        <h1 id="board-title" className={s.heading}>
          Leaderboard
        </h1>
      </header>
      <table className={s.board} data-testid="leaderboard">
        <VisuallyHidden as="caption">Top {view.entries.length} players</VisuallyHidden>
        <thead>
          <tr>
            <th scope="col">
              <VisuallyHidden>Rank</VisuallyHidden>
            </th>
            <th scope="col">
              <VisuallyHidden>Player</VisuallyHidden>
            </th>
            <th scope="col">
              <VisuallyHidden>Score</VisuallyHidden>
            </th>
            <th scope="col">
              <VisuallyHidden>Points gained</VisuallyHidden>
            </th>
          </tr>
        </thead>
        <tbody>
          {view.entries.map((e) => {
            const move = moves.get(e.playerId);
            return (
              <tr
                key={e.playerId}
                data-moves={move !== undefined ? '' : undefined}
                style={move !== undefined ? style({ '--from': move }) : undefined}
              >
                <td>{ordinal(e.rank)}</td>
                <td className={s.nick}>{e.nickname}</td>
                <td className={s.score}>{groupDigits(e.score)}</td>
                <td className={s.delta}>{e.delta > 0 ? `+${groupDigits(e.delta)}` : ''}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </section>
  );
}

type PodiumView = Extract<PresenterView, { screen: 'podium' }>;

const STEP_HEIGHT_U: Record<number, number> = { 1: 32, 2: 24, 3: 18 };

/** The top three, first in the middle, in a slow fade (no confetti, no strobe). */
export function PodiumScreen({ view }: { view: PodiumView }) {
  return (
    <section className={s.screen} aria-labelledby="podium-title">
      <header className={s.headText}>
        <p className={s.meta}>{view.quizTitle}</p>
        <h1 id="podium-title" className={s.heading}>
          Final results
        </h1>
      </header>
      <ol className={s.podium} data-testid="podium">
        {view.podium.map((e) => (
          <li key={e.playerId} className={s.step} data-place={Math.min(e.rank, 3)}>
            <span className={s.stepName}>{e.nickname}</span>
            <span className={s.stepScore}>{groupDigits(e.score)} points</span>
            <span
              className={s.block}
              style={{ height: `calc(var(--u) * ${STEP_HEIGHT_U[Math.min(e.rank, 3)] ?? 18})` }}
            >
              <VisuallyHidden>Place </VisuallyHidden>
              {e.rank}
            </span>
          </li>
        ))}
      </ol>
    </section>
  );
}

type ThanksView = Extract<PresenterView, { screen: 'thanks' }>;

/** A quiz with no scored questions has no winners: thank the room instead. */
export function ThanksScreen({ view }: { view: ThanksView }) {
  return (
    <section className={`${s.screen} ${s.centered}`} aria-labelledby="thanks-title">
      <h1 id="thanks-title" className={s.big}>
        Thanks for taking part
      </h1>
      <p className={s.lead}>
        {view.quizTitle} · {groupDigits(view.players)} {view.players === 1 ? 'player' : 'players'}
      </p>
    </section>
  );
}

export function ConnectingScreen() {
  return (
    <section className={`${s.screen} ${s.centered}`} aria-labelledby="connecting-title">
      <h1 id="connecting-title" className={s.heading}>
        Connecting…
      </h1>
    </section>
  );
}

const OVER_COPY: Record<HostEnd, { title: string; body: string }> = {
  'session-ended': { title: 'This game has ended', body: 'Thanks for playing.' },
  'not-found': {
    title: "We couldn't find this game",
    body: 'It may be over, or the link may be out of date.',
  },
  unauthorized: {
    title: 'Sign in again to show this game',
    body: 'Your sign-in ended. Open the presenter from the host page.',
  },
  'out-of-date': {
    title: 'This page is out of date',
    body: 'Reload it to carry on where the game is.',
  },
};

export function OverScreen({ reason, onReload }: { reason: HostEnd; onReload: () => void }) {
  const copy = OVER_COPY[reason];
  return (
    <section className={`${s.screen} ${s.centered}`} aria-labelledby="over-title">
      <h1 id="over-title" className={s.big}>
        {copy.title}
      </h1>
      <p className={s.lead}>{copy.body}</p>
      {reason === 'out-of-date' && (
        <button type="button" className={s.reload} onClick={onReload}>
          Reload
        </button>
      )}
    </section>
  );
}
