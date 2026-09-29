import { describe, expect, it } from 'vitest';
import type { PresenterView } from '../src/state/presenterView.ts';
import {
  JOIN_ANNOUNCE_MS,
  announcementFor,
  joinAnnouncement,
} from '../src/screens/present/announce.ts';

type Lobby = Extract<PresenterView, { screen: 'lobby' }>;
const lobby = (names: string[], pin = '482915'): Lobby => ({
  screen: 'lobby',
  quizTitle: 'Friday night trivia',
  pin,
  locked: false,
  names,
});

describe('the presenter lobby announcement', () => {
  it('says the PIN, digit by digit, and where the game is', () => {
    expect(announcementFor(lobby([]))).toBe('Lobby. PIN 4 8 2 9 1 5.');
  });

  it('is the same sentence however many players have joined, so a join never repeats it', () => {
    const empty = announcementFor(lobby([]));
    for (const n of [1, 2, 3, 22, 400]) {
      const names = Array.from({ length: n }, (_, i) => `Player ${i}`);
      expect(announcementFor(lobby(names)), `${n} players`).toBe(empty);
    }
  });

  it('changes when the PIN does, and only then', () => {
    expect(announcementFor(lobby([], '111222'))).not.toBe(announcementFor(lobby([])));
  });
});

describe('the join announcement', () => {
  it('carries no PIN and reads as a sentence, with the right plural', () => {
    expect(joinAnnouncement(1)).toBe('1 player has joined.');
    expect(joinAnnouncement(2)).toBe('2 players have joined.');
    expect(joinAnnouncement(400)).toBe('400 players have joined.');
    for (const n of [1, 2, 22, 400]) expect(joinAnnouncement(n)).not.toMatch(/PIN|\d{6}/i);
  });

  it('never says "1 players", or anything for an empty room', () => {
    expect(joinAnnouncement(1)).not.toMatch(/1 players/);
    expect(joinAnnouncement(0)).toBe('');
    expect(joinAnnouncement(-1)).toBe('');
  });

  it('the join throttle is ten seconds', () => {
    expect(JOIN_ANNOUNCE_MS).toBe(10_000);
  });
});
