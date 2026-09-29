import { useId, useMemo, useState } from 'react';
import type { RosterEntry } from '@zqhoot/protocol';
import { Button } from '../../ui/Button.tsx';
import { ConfirmDialog } from '../../ui/ConfirmDialog.tsx';
import { TextField } from '../../ui/TextField.tsx';
import styles from './Host.module.css';

/** Newest first, so a person who has just joined is at the top of the list. */
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

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    const all = [...roster].reverse();
    return q === '' ? all : all.filter((r) => r.nickname.toLowerCase().includes(q));
  }, [roster, query]);
  const connected = roster.filter((r) => r.connected).length;

  return (
    <div className={styles.rosterBox}>
      <p className={styles.meta} id={`${listId}-count`}>
        {roster.length} {roster.length === 1 ? 'player' : 'players'}, {connected} connected
      </p>
      <TextField
        label="Find a player"
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
              <li key={r.playerId} className={styles.rosterRow}>
                <span className={styles.rosterName}>{r.nickname}</span>
                <span className={styles.meta}>{r.connected ? 'connected' : 'offline'}</span>
                <Button
                  size="compact"
                  variant="secondary"
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
          if (pending) onKick(pending.playerId);
          setPending(null);
        }}
      />
    </div>
  );
}
