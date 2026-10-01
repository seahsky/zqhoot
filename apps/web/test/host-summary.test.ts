import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { HostSnapshot, ServerMessage } from '@zqhoot/protocol';
import { NOW } from '../src/dev/fixtures/common.ts';
import { hostSnapshot, roster } from '../src/dev/fixtures/hostSnapshots.ts';
import { LiveScreen } from '../src/screens/host/LiveScreen.tsx';
import { playerCountLabel } from '../src/screens/host/format.ts';
import { hostReducer, initialHostState } from '../src/state/host.ts';
import type { HostState } from '../src/state/host.ts';

const send = (state: HostState, msg: ServerMessage) => hostReducer(state, { type: 'message', msg });
const welcome = (snapshot: HostSnapshot): ServerMessage => ({
  type: 'welcome',
  ts: NOW,
  role: 'host',
  snapshot,
});

/** The chips under the session title, as text. */
function chipsOf(state: HostState): string[] {
  const noop = () => undefined;
  const html = renderToStaticMarkup(
    createElement(LiveScreen, {
      state,
      joinUrl: 'zq.example',
      displayName: null,
      onSignOut: noop,
      onNext: noop,
      onSkip: noop,
      onEnd: noop,
      onLock: noop,
      onKick: noop,
      onModerate: noop,
      onOpenPresenter: noop,
      onDismissNotice: noop,
    }),
  );
  const list = /<ul class="[^"]*chips[^"]*">(.*?)<\/ul>/s.exec(html)?.[1] ?? '';
  return [...list.matchAll(/<li[^>]*>(.*?)<\/li>/gs)].map((m) => m[1] as string);
}

describe('the player count in the host header', () => {
  it('says "player" for one and "players" otherwise', () => {
    expect(playerCountLabel(0)).toBe('0 players');
    expect(playerCountLabel(1)).toBe('1 player');
    expect(playerCountLabel(5)).toBe('5 players');
  });

  it('follows the live roster, not the snapshot the roster started from', () => {
    // The lobby's snapshot is taken with nobody in it; players arrive as roster deltas.
    let state = send(initialHostState('open'), welcome(hostSnapshot({ roster: [] })));
    expect(chipsOf(state)).toContain('0 players');

    state = send(state, { type: 'roster', ts: NOW, upsert: roster(5), removed: [] });
    expect(state.snapshot?.roster).toHaveLength(0);
    expect(chipsOf(state)).toContain('5 players');

    state = send(state, { type: 'roster', ts: NOW, upsert: [], removed: ['player-0002'] });
    expect(chipsOf(state)).toContain('4 players');

    state = send(state, {
      type: 'roster',
      ts: NOW,
      upsert: [],
      removed: ['player-0001', 'player-0003', 'player-0004'],
    });
    expect(chipsOf(state)).toContain('1 player');
  });
});
