import { useEffect, useId, useMemo, useRef, useState } from 'react';
import type { RosterEntry } from '@zqhoot/protocol';
import { Button } from '../../ui/Button.tsx';
import { ConfirmDialog } from '../../ui/ConfirmDialog.tsx';
import { rescueFocus } from '../../ui/focus.ts';
import { TextField } from '../../ui/TextField.tsx';
import styles from './Host.module.css';

/** How long after a kick the row may still be there before we stop waiting to move focus. */
const KICK_FOCUS_WAIT_MS = 10_000;

/**
 * Newest first, so a person who has just joined is at the top of the list. A kick is confirmed
 * in a dialog and takes effect when the server's roster update arrives, which removes the row
 * the Kick button was in. Focus then goes to the next row's Kick button, or to the search box
 * when there is no next row.
 */
export function Roster({
  roster,
  onKick,
}: {
  roster: readonly RosterEntry[];
  onKick: (playerId: string) => void;
}) {
  const [query, setQuery] = useState('');
  const [pending, setPending] = useState<RosterEntry | null>(null);
  const listId = useId();
  const box = useRef<HTMLDivElement>(null);
  const search = useRef<HTMLInputElement>(null);
  const kicked = useRef<{ playerId: string; nextId: string | null; until: number } | null>(null);

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    const all = [...roster].reverse();
    return q === '' ? all : all.filter((r) => r.nickname.toLowerCase().includes(q));
  }, [roster, query]);
  const connected = roster.filter((r) => r.connected).length;

  useEffect(() => {
    const plan = kicked.current;
    if (!plan) return;
    if (Date.now() > plan.until) {
      kicked.current = null;
      return;
    }
    if (roster.some((r) => r.playerId === plan.playerId)) return; // the server has not acted yet
    kicked.current = null;
    const next = plan.nextId
      ? box.current?.querySelector<HTMLElement>(`[data-player="${plan.nextId}"] button`)
      : null;
    rescueFocus(next ?? search.current);
  }, [roster]);

  return (
    <div className={styles.rosterBox} ref={box}>
      <p className={styles.meta} id={`${listId}-count`}>
        {roster.length} {roster.length === 1 ? 'player' : 'players'}, {connected} connected
      </p>
      <TextField
        label="Find a player"
        inputRef={search}
        type="search"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        autoComplete="off"
        spellCheck={false}
      />
      {query.trim() !== '' && (
        <p className={styles.meta} role="status">
          {shown.length} of {roster.length} shown
        </p>
      )}
      {/* Scrollable, so it must be reachable by keyboard (WCAG 2.1.1, axe scrollable-region). */}
      <div
        className={styles.rosterScroll}
        role="region"
        aria-label="Players"
        tabIndex={0}
        data-testid="roster"
      >
        {shown.length === 0 ? (
          <p className={styles.meta}>
            {roster.length === 0 ? 'Nobody has joined yet.' : 'No player matches.'}
          </p>
        ) : (
          <ul className={styles.rosterList}>
            {shown.map((r) => (
              <li key={r.playerId} className={styles.rosterRow} data-player={r.playerId}>
                <span className={styles.rosterName}>{r.nickname}</span>
                <span className={styles.rosterStatus} data-online={r.connected}>
                  {r.connected ? 'connected' : 'offline'}
                </span>
                <Button
                  size="compact"
                  variant="secondary"
                  className={styles.rosterKick}
                  onClick={() => setPending(r)}
                  aria-label={`Kick ${r.nickname}`}
                >
                  Kick
                </Button>
              </li>
            ))}
          </ul>
        )}
      </div>
      <ConfirmDialog
        open={pending !== null}
        title="Remove this player?"
        body={
          pending
            ? `${pending.nickname} will be removed from the game. Their score is dropped from the results.`
            : ''
        }
        confirmLabel="Remove player"
        onCancel={() => setPending(null)}
        onConfirm={() => {
          if (pending) {
            const at = shown.findIndex((r) => r.playerId === pending.playerId);
            kicked.current = {
              playerId: pending.playerId,
              nextId: shown[at + 1]?.playerId ?? null,
              until: Date.now() + KICK_FOCUS_WAIT_MS,
            };
            onKick(pending.playerId);
          }
          setPending(null);
        }}
      />
    </div>
  );
}
