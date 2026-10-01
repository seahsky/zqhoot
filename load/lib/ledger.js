// Delivery accounting for one player (no k6 imports, so it runs under `node --test`).
//
// A player is owed a fixed sequence of state messages: per question `question` and `reveal`, plus
// `leaderboard` when the question is scored, then one `ended`. Each entry has one status:
//
//   received  arrived as a broadcast, or was reported by a `welcome` snapshot for that phase
//   lost      owed while connected (or never recovered) and did not arrive: a real loss
//   missed    fell inside a disconnect window that a successful `resume` closed: no replay is
//             promised (ADR-0008), so it is reported separately and is not a loss
//   skipped   before the phase the player joined in (joined after the game started)
//
// Only received + lost count as expected. Classification is by ordinal position in the sequence,
// which is exact because the host advances one phase at a time and a socket delivers in order.

export const MESSAGE_TYPES = ['question', 'reveal', 'leaderboard', 'ended'];

/** `scored[i]` is true when question i is followed by a leaderboard. */
export function buildSequence(scored) {
  const seq = [];
  scored.forEach((isScored, index) => {
    seq.push({ key: `q${index}:question`, type: 'question', index });
    seq.push({ key: `q${index}:reveal`, type: 'reveal', index });
    if (isScored) seq.push({ key: `q${index}:leaderboard`, type: 'leaderboard', index });
  });
  seq.push({ key: 'ended', type: 'ended', index: scored.length - 1 });
  return seq;
}

/**
 * The sequence entry a `welcome` snapshot stands in for. In `revealing` the reveal has not been
 * sent yet (it follows as a broadcast), so the snapshot covers the question only.
 */
export function snapshotKey(phase, questionIndex) {
  switch (phase) {
    case 'question':
    case 'revealing':
      return `q${questionIndex}:question`;
    case 'reveal':
      return `q${questionIndex}:reveal`;
    case 'leaderboard':
      return `q${questionIndex}:leaderboard`;
    case 'ended':
      return 'ended';
    default:
      return null;
  }
}

const emptyCounts = () => ({ expected: 0, received: 0, lost: 0, missed: 0, skipped: 0 });

export class Ledger {
  constructor(sequence) {
    this.seq = sequence;
    this.ordinal = new Map(sequence.map((e, i) => [e.key, i]));
    this.status = sequence.map(() => 'pending');
    this.viaSnapshot = sequence.map(() => false);
    this.highWater = -1;
    // Non-null while disconnected: the highest ordinal received before the socket went away.
    this.floor = null;
    this.duplicates = 0;
  }

  /** A broadcast arrived. Returns 'first', 'duplicate' or 'unknown' (not in this game's plan). */
  receive(key) {
    const i = this.ordinal.get(key);
    if (i === undefined) return 'unknown';
    if (this.status[i] === 'received') {
      this.duplicates += 1;
      return 'duplicate';
    }
    this.status[i] = 'received';
    this.highWater = Math.max(this.highWater, i);
    return 'first';
  }

  /**
   * The socket went away. Anything still owed from before the last received message was lost
   * while connected: a later message got through on the same in-order socket.
   */
  disconnect() {
    if (this.floor !== null) return;
    this.floor = this.highWater;
    for (let i = 0; i < this.floor; i++) {
      if (this.status[i] === 'pending') this.status[i] = 'lost';
    }
  }

  /**
   * `welcome` after a successful `resume`. Owed messages between the disconnect and the phase the
   * snapshot reports are the disconnect window; the snapshot itself counts for its phase.
   */
  resume(key) {
    const covered = this._ordinalOf(key);
    const floor = this.floor ?? this.highWater;
    for (let i = floor + 1; i < covered; i++) {
      if (this.status[i] === 'pending') this.status[i] = 'missed';
    }
    this._cover(covered);
    this.floor = null;
  }

  /** `welcome` after `join`. A player joining mid-game is not owed what came before. */
  join(key) {
    const covered = this._ordinalOf(key);
    for (let i = 0; i < covered; i++) {
      if (this.status[i] === 'pending') this.status[i] = 'skipped';
    }
    this._cover(covered);
  }

  _ordinalOf(key) {
    if (key === null) return -1;
    return this.ordinal.get(key) ?? -1;
  }

  _cover(ordinal) {
    if (ordinal < 0 || this.status[ordinal] === 'received') return;
    this.status[ordinal] = 'received';
    this.viaSnapshot[ordinal] = true;
    this.highWater = Math.max(this.highWater, ordinal);
  }

  /** End of the player's game: whatever is still owed was lost. Safe to call more than once. */
  settle() {
    for (let i = 0; i < this.status.length; i++) {
      if (this.status[i] === 'pending') this.status[i] = 'lost';
    }
    const total = emptyCounts();
    const byType = Object.fromEntries(MESSAGE_TYPES.map((t) => [t, emptyCounts()]));
    let viaSnapshot = 0;
    this.seq.forEach((entry, i) => {
      const status = this.status[i];
      for (const bucket of [total, byType[entry.type]]) {
        bucket[status] += 1;
        if (status === 'received' || status === 'lost') bucket.expected += 1;
      }
      if (this.viaSnapshot[i] && status === 'received') viaSnapshot += 1;
    });
    return { ...total, byType, viaSnapshot, duplicates: this.duplicates };
  }
}
