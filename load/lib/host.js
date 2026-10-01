import { everyoneAnswered, timerCloseDelayMs } from './close.js';
import { cfg } from './config.js';
import { hostTransition, joinPhase, recordError } from './metrics.js';
import {
  ClockOffset,
  closeSocket,
  isOpen,
  openSocket,
  parseMessage,
  receiptTime,
} from './socket.js';

const PROTOCOL_VERSION = 1;
const COMMAND_ATTEMPTS = 3;

export function runHost(data) {
  new Host(data).start();
}

/**
 * The presenter's control screen, driven the way the web app drives it: `host.next` to open a
 * question, `host.stats` once a second while it is open, `host.close` when everyone has answered
 * or the answer grace after the deadline is over, then `host.next` through reveal and leaderboard.
 * Every command carries
 * the `from` the host last saw, so sending one twice is a no-op on the server.
 */
class Host {
  constructor(data) {
    this.data = data;
    this.ws = null;
    this.gen = 0;
    this.finished = false;
    this.timers = new Set();
    this.intervals = new Set();
    this.clock = new ClockOffset();
    this.roster = new Set();
    this.sv = -1;
    this.phase = null;
    this.questionIndex = -1;
    this.totalQuestions = cfg.questions;
    this.question = null;
    this.lastPhaseKey = '';
    this.started = false;
    this.connectedAt = 0;
    this.pending = null;
    this.closing = false;
    this.pollTimer = null;
    this.closeTimer = null;
    this.rosterTimer = null;
  }

  after(ms, fn) {
    const id = setTimeout(
      () => {
        this.timers.delete(id);
        if (!this.finished) fn();
      },
      Math.max(0, ms),
    );
    this.timers.add(id);
    return id;
  }

  every(ms, fn) {
    const id = setInterval(() => {
      if (!this.finished) fn();
    }, ms);
    this.intervals.add(id);
    return id;
  }

  cancel(id) {
    if (id === null) return;
    clearTimeout(id);
    this.timers.delete(id);
  }

  stopEvery(id) {
    if (id === null) return;
    clearInterval(id);
    this.intervals.delete(id);
  }

  start() {
    this.after(cfg.budgetSec * 1000, () => {
      recordError('host-timeout');
      this.finish('budget');
    });
    this.connect();
  }

  connect() {
    const gen = ++this.gen;
    this.clock.reset();
    const ws = openSocket(this.data.wsUrl);
    this.ws = ws;
    ws.addEventListener('open', () => {
      if (gen !== this.gen || this.finished) {
        closeSocket(ws, 'stale');
        return;
      }
      this.send({
        type: 'host.hello',
        v: PROTOCOL_VERSION,
        sessionId: this.data.sessionId,
        client: 'control',
        authToken: this.data.token,
      });
    });
    ws.addEventListener('message', (event) => {
      if (gen === this.gen && !this.finished) this.onMessage(event);
    });
    ws.addEventListener('close', () => {
      if (gen !== this.gen || this.finished) return;
      // The real control screen reconnects and asks for a fresh snapshot.
      recordError('host-closed');
      this.ws = null;
      this.after(500, () => this.connect());
    });
    ws.addEventListener('error', () => {
      if (gen === this.gen && !this.finished) recordError('ws-error');
    });
  }

  send(message) {
    if (!isOpen(this.ws)) return false;
    try {
      this.ws.send(JSON.stringify(message));
      return true;
    } catch (err) {
      return false;
    }
  }

  onMessage(event) {
    const receivedAt = receiptTime(event);
    const message = parseMessage(event);
    if (message === null) return;
    this.clock.observe(receivedAt, message.ts);
    switch (message.type) {
      case 'welcome':
        if (message.role === 'host') this.onSnapshot(message.snapshot, receivedAt, true);
        break;
      case 'host.state':
        this.onSnapshot(message.snapshot, receivedAt, false);
        break;
      case 'roster':
        for (const entry of message.upsert) this.roster.add(entry.playerId);
        for (const id of message.removed) this.roster.delete(id);
        break;
      case 'stats':
        this.onStats(message);
        break;
      case 'error':
        recordError(message.code);
        if (!this.started && message.ref === 'host.hello') this.finish('hello-refused');
        break;
      default:
        break;
    }
  }

  onSnapshot(snapshot, receivedAt, isWelcome) {
    if (snapshot.sv < this.sv) return;
    this.sv = snapshot.sv;
    this.phase = snapshot.phase;
    this.questionIndex = snapshot.questionIndex;
    this.totalQuestions = snapshot.totalQuestions;
    this.question = snapshot.question ?? null;
    this.roster = new Set(snapshot.roster.map((entry) => entry.playerId));
    if (isWelcome) {
      this.onWelcome();
      return;
    }
    this.onState(receivedAt);
  }

  onWelcome() {
    if (this.rosterTimer === null && !this.started) {
      this.connectedAt = Date.now();
      this.rosterTimer = this.every(200, () => this.checkRoster());
      return;
    }
    // A reconnect mid-game: repeat what was waiting on an answer (harmless if it was applied).
    if (this.pending !== null) this.send(this.pending.message);
    this.onState(Date.now());
  }

  /** Wait for the whole room, then start. A room that never fills starts with whoever came. */
  checkRoster() {
    const waited = Date.now() - this.connectedAt;
    const full = this.roster.size >= cfg.players;
    if (!full && waited < cfg.joinTimeoutSec * 1000) return;
    this.stopEvery(this.rosterTimer);
    this.rosterTimer = null;
    if (!full) recordError('join-timeout');
    joinPhase.add(waited);
    console.log(
      `zq-host: starting with ${this.roster.size}/${cfg.players} players after ${waited} ms`,
    );
    if (this.roster.size === 0) {
      this.finish('empty-room');
      return;
    }
    this.started = true;
    this.next();
  }

  // ---------------------------------------------------------------------------------------
  // Commands
  // ---------------------------------------------------------------------------------------

  /** `host.next` from the phase the host is looking at, and what the server should answer with. */
  next() {
    const from = { phase: this.phase, questionIndex: this.questionIndex };
    const index = this.questionIndex;
    const lastQuestion = index + 1 >= this.totalQuestions;
    const scored = this.data.scored[index] === true;
    let step;
    let expect;
    if (this.phase === 'lobby') {
      step = 'open-first';
      expect = (phase, i) => phase === 'question' && i === 0;
    } else if (this.phase === 'reveal' && scored) {
      step = 'reveal-leaderboard';
      expect = (phase, i) => phase === 'leaderboard' && i === index;
    } else if (lastQuestion) {
      step = 'end';
      expect = (phase) => phase === 'ended';
    } else {
      step = 'open-next';
      expect = (phase, i) => phase === 'question' && i === index + 1;
    }
    this.command(step, { type: 'host.next', from }, expect);
  }

  command(step, message, expect) {
    const pending = { step, message, expect, sentAt: Date.now(), attempts: 1, timer: null };
    pending.timer = this.after(cfg.stepTimeoutMs, () => this.stepTimedOut());
    this.pending = pending;
    this.send(message);
  }

  stepTimedOut() {
    const pending = this.pending;
    if (pending === null) return;
    recordError('host-timeout');
    if (pending.attempts >= COMMAND_ATTEMPTS) {
      this.finish('stuck');
      return;
    }
    pending.attempts += 1;
    pending.timer = this.after(cfg.stepTimeoutMs, () => this.stepTimedOut());
    this.send(pending.message);
  }

  /** A `host.state` arrived: settle the pending command if this is its answer, then act. */
  onState(receivedAt) {
    const pending = this.pending;
    if (pending !== null && pending.expect(this.phase, this.questionIndex)) {
      this.cancel(pending.timer);
      this.pending = null;
      hostTransition.add(receivedAt - pending.sentAt, {
        step: pending.step,
        q: String(this.questionIndex),
      });
    }
    const key = `${this.phase}:${this.questionIndex}`;
    if (key === this.lastPhaseKey || !this.started) return;
    this.lastPhaseKey = key;
    this.onPhase();
  }

  onPhase() {
    switch (this.phase) {
      case 'question':
        this.startQuestion();
        break;
      case 'reveal':
      case 'leaderboard':
        this.stopQuestion();
        this.after(cfg.dwellMs, () => this.next());
        break;
      case 'ended':
        this.stopQuestion();
        this.finish('ended');
        break;
      default:
        break;
    }
  }

  // ---------------------------------------------------------------------------------------
  // An open question
  // ---------------------------------------------------------------------------------------

  startQuestion() {
    this.stopQuestion();
    this.closing = false;
    const index = this.questionIndex;
    this.pollTimer = this.every(cfg.statsPollMs, () => {
      if (this.phase === 'question') this.send({ type: 'host.stats', questionIndex: index });
    });
    const deadline = this.question === null ? null : this.question.deadline;
    if (deadline !== null) {
      // The host's own clock, moved onto the server's timeline by the offset rule.
      this.closeTimer = this.after(timerCloseDelayMs(deadline, this.clock.get(), Date.now()), () =>
        this.close('timer'),
      );
    }
  }

  stopQuestion() {
    this.stopEvery(this.pollTimer);
    this.pollTimer = null;
    this.cancel(this.closeTimer);
    this.closeTimer = null;
  }

  onStats(message) {
    if (this.phase !== 'question' || message.questionIndex !== this.questionIndex) return;
    if (everyoneAnswered(message.stats)) this.close('all-answered');
  }

  close(reason) {
    if (this.closing || this.phase !== 'question') return;
    this.closing = true;
    const index = this.questionIndex;
    this.command(
      'close-reveal',
      { type: 'host.close', questionIndex: index, reason },
      (phase, i) => phase === 'reveal' && i === index,
    );
  }

  finish(reason) {
    if (this.finished) return;
    this.finished = true;
    for (const id of this.timers) clearTimeout(id);
    for (const id of this.intervals) clearInterval(id);
    this.timers.clear();
    this.intervals.clear();
    console.log(`zq-host: finished (${reason})`);
    const ws = this.ws;
    this.ws = null;
    if (ws !== null) closeSocket(ws, reason);
  }
}
