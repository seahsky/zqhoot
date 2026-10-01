import exec from 'k6/execution';
import { sleep } from 'k6';
import { cfg } from './config.js';
import { lookupPin } from './api.js';
import { Ledger, MESSAGE_TYPES, buildSequence, snapshotKey } from './ledger.js';
import {
  answerAccepted,
  answerAck,
  broadcastLatency,
  joinSuccess,
  msgDuplicate,
  msgExpected,
  msgMissedWhileDisconnected,
  msgReceived,
  msgViaSnapshot,
  questionMargin,
  recordError,
  resumeSuccess,
} from './metrics.js';
import { isSelected, makeRng } from './rng.js';
import {
  ClockOffset,
  closeSocket,
  isOpen,
  openSocket,
  parseMessage,
  receiptTime,
} from './socket.js';

const PROTOCOL_VERSION = 1;
const clamp = (value, lo, hi) => Math.min(hi, Math.max(lo, value));

export function runPlayer(data) {
  const index = exec.scenario.iterationInTest;
  const rng = makeRng(cfg.seed, index + 1);
  // A room does not join in one instant: spread the arrivals.
  sleep(rng.range(0, cfg.joinRampSec));
  new Player(data, index, rng).start();
}

class Player {
  constructor(data, index, rng) {
    this.data = data;
    this.rng = rng;
    this.nickname = `lp-${String(index + 1).padStart(4, '0')}`;
    this.sequence = buildSequence(data.scored);
    this.ledger = null;
    this.creds = null;
    this.ws = null;
    this.gen = 0;
    this.mode = 'join';
    this.ready = false;
    this.clock = new ClockOffset();
    this.plans = new Map();
    this.timers = new Set();
    this.welcomeTimer = null;
    this.finished = false;
    this.resumeAttempt = 0;
    // Chosen by player number alone, so a run always drops the same players.
    this.dropQuestion = isSelected(index, cfg.reconnectRatio) ? this.pickDropQuestion() : -1;
    this.dropScheduled = false;
    this.dropDone = false;
  }

  /** Mid-game: never the first or last question when there are enough of them. */
  pickDropQuestion() {
    const last = cfg.questions - 1;
    return last < 2 ? 0 : this.rng.int(1, last - 1);
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

  cancel(id) {
    if (id === null) return;
    clearTimeout(id);
    this.timers.delete(id);
  }

  start() {
    this.after(cfg.budgetSec * 1000, () => {
      recordError('player-timeout');
      this.finish('timeout');
    });
    const res = lookupPin(this.data.apiUrl, this.data.pin);
    let joinable = false;
    let body = null;
    if (res.status === 200) {
      try {
        body = res.json();
      } catch (err) {
        // An HTTP 200 that is not JSON is as unusable as an error status.
      }
    }
    if (body === null) {
      recordError('http-lookup');
    } else if (body.joinable === true) {
      joinable = true;
    } else {
      recordError('not-joinable');
    }
    if (!joinable) {
      joinSuccess.add(0);
      this.finish('lookup');
      return;
    }
    this.connect('join');
  }

  // ---------------------------------------------------------------------------------------
  // Connection
  // ---------------------------------------------------------------------------------------

  connect(mode) {
    this.abandonSocket();
    const gen = ++this.gen;
    this.mode = mode;
    this.ready = false;
    this.clock.reset();
    const ws = openSocket(this.data.wsUrl);
    this.ws = ws;
    ws.addEventListener('open', () => {
      if (gen !== this.gen || this.finished) {
        // Abandoned while still connecting; an orphan socket would keep the VU alive.
        closeSocket(ws, 'stale');
        return;
      }
      const hello =
        mode === 'join'
          ? { type: 'join', v: PROTOCOL_VERSION, pin: this.data.pin, nickname: this.nickname }
          : { type: 'resume', v: PROTOCOL_VERSION, ...this.creds };
      this.send(hello);
      this.welcomeTimer = this.after(cfg.welcomeTimeoutMs, () => {
        recordError('welcome-timeout');
        this.welcomeFailed();
      });
    });
    ws.addEventListener('message', (event) => {
      if (gen === this.gen && !this.finished) this.onMessage(event);
    });
    ws.addEventListener('close', () => {
      if (gen === this.gen) this.onClose();
    });
    ws.addEventListener('error', () => {
      if (gen === this.gen && !this.finished) recordError('ws-error');
    });
  }

  /** Stops listening to the current socket and closes it; its late events are ignored. */
  abandonSocket() {
    const ws = this.ws;
    this.ws = null;
    this.ready = false;
    this.gen += 1;
    this.cancel(this.welcomeTimer);
    this.welcomeTimer = null;
    if (ws !== null) closeSocket(ws, 'load-test');
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

  onClose() {
    if (this.finished) return;
    const welcomed = this.ready;
    this.ready = false;
    this.ws = null;
    recordError('ws-closed');
    if (!welcomed) {
      this.welcomeFailed();
      return;
    }
    // The server ended a live connection. A client would resume.
    this.ledger.disconnect();
    this.resumeAttempt = 0;
    this.after(1000, () => this.resume());
  }

  resume() {
    this.resumeAttempt += 1;
    this.connect('resume');
  }

  welcomeFailed() {
    this.cancel(this.welcomeTimer);
    this.welcomeTimer = null;
    if (this.mode === 'join') {
      joinSuccess.add(0);
      this.finish('join-failed');
      return;
    }
    resumeSuccess.add(0);
    this.abandonSocket();
    if (this.resumeAttempt > cfg.resumeRetries) {
      this.finish('resume-failed');
      return;
    }
    this.after(1000 * this.resumeAttempt, () => this.resume());
  }

  // ---------------------------------------------------------------------------------------
  // Messages
  // ---------------------------------------------------------------------------------------

  onMessage(event) {
    const receivedAt = receiptTime(event);
    const message = parseMessage(event);
    if (message === null) return;
    this.clock.observe(receivedAt, message.ts);
    switch (message.type) {
      case 'welcome':
        this.onWelcome(message);
        break;
      case 'error':
        this.onServerError(message);
        break;
      case 'question':
        this.onQuestion(message, receivedAt);
        break;
      case 'answer.ack':
        this.onAck(message, receivedAt);
        break;
      case 'reveal':
      case 'leaderboard':
      case 'ended':
        this.onState(message, receivedAt);
        break;
      case 'kicked':
        recordError('kicked');
        this.finish('kicked');
        break;
      default:
        break;
    }
  }

  onWelcome(message) {
    if (this.ready || message.role !== 'player') return;
    this.cancel(this.welcomeTimer);
    this.welcomeTimer = null;
    this.ready = true;
    const snapshot = message.snapshot;
    const covers = snapshotKey(snapshot.phase, snapshot.questionIndex);
    if (this.mode === 'join') {
      joinSuccess.add(1);
      this.creds = message.credentials;
      this.ledger = new Ledger(this.sequence);
      this.ledger.join(covers);
    } else {
      resumeSuccess.add(1);
      this.resumeAttempt = 0;
      this.ledger.resume(covers);
    }
    this.afterSnapshot(snapshot);
  }

  /** What a snapshot means for an answer: still to give, already recorded, or too late. */
  afterSnapshot(snapshot) {
    if (snapshot.phase === 'question' && snapshot.question !== undefined) {
      const { question, openAt, deadline } = snapshot.question;
      this.openQuestion(snapshot.questionIndex, question, openAt, deadline, snapshot.responses);
      this.maybeScheduleDrop(snapshot.questionIndex);
      return;
    }
    // Past the question: a revealed snapshot says whether an answer whose ack died with the old
    // socket counted. In `revealing` the reveal itself follows and settles it (see onState).
    if (snapshot.phase === 'reveal' && snapshot.reveal !== undefined) {
      this.resolveByOutcome(snapshot.questionIndex, snapshot.reveal.you);
    }
    this.closeOpenPlans(snapshot.questionIndex);
    // Back after the game ended: no `ended` broadcast will follow, and the ledger has just counted
    // the snapshot for it, so there is nothing left to wait for.
    if (snapshot.phase === 'ended') this.finish('ended');
  }

  onServerError(message) {
    recordError(message.code);
    if (!this.ready) this.welcomeFailed();
  }

  onQuestion(message, receivedAt) {
    if (this.ledger === null) return;
    broadcastLatency.add(receivedAt - message.ts, { type: 'question' });
    this.ledger.receive(`q${message.index}:question`);
    questionMargin.add(message.openAt + this.clock.get() - receivedAt);
    this.openQuestion(message.index, message.question, message.openAt, message.deadline, null);
    this.maybeScheduleDrop(message.index);
  }

  onState(message, receivedAt) {
    if (this.ledger === null) return;
    broadcastLatency.add(receivedAt - message.ts, { type: message.type });
    if (message.type === 'ended') {
      this.ledger.receive('ended');
      this.finish('ended');
      return;
    }
    this.ledger.receive(`q${message.index}:${message.type}`);
    if (message.type === 'reveal') {
      this.resolveByOutcome(message.index, message.you);
      this.closeOpenPlans(message.index);
    }
  }

  /**
   * An answer that was sent but whose ack can no longer come (the socket that sent it was dropped)
   * is settled by the reveal: `you.answered` says whether the server recorded it. One
   * observation per answer, whichever of the ack and the outcome gets here first.
   */
  resolveByOutcome(index, outcome) {
    const plan = this.plans.get(index);
    if (plan === undefined || plan.state !== 'sent') return;
    // Sent on the socket still open: the ack can yet arrive and gives the latency sample.
    if (plan.gen === this.gen) return;
    plan.state = 'acked';
    const recorded = outcome !== undefined && outcome.answered === true;
    answerAccepted.add(recorded);
    if (!recorded) recordError('answer-lost');
  }

  // ---------------------------------------------------------------------------------------
  // Answering
  // ---------------------------------------------------------------------------------------

  /**
   * Plans the answer once per question: `openAt` on the server clock moved onto ours with the
   * offset rule, plus a log-normal think time (median 3 s) clipped to 0.4 s .. limit - 1 s.
   * `recorded` is the responses a resume snapshot says the server already holds.
   */
  openQuestion(index, question, openAt, deadline, recorded) {
    let plan = this.plans.get(index);
    if (plan === undefined) {
      const thinkSec = clamp(
        this.rng.lognormal(cfg.answerMedianSec, cfg.answerSigma),
        0.4,
        Math.max(0.4, cfg.timeLimit - 1),
      );
      plan = {
        index,
        payload: this.choose(question),
        at: openAt + this.clock.get() + thinkSec * 1000,
        state: 'planned',
        timer: null,
        sentAt: 0,
        gen: 0,
      };
      this.plans.set(index, plan);
    }
    if (recorded !== null && recorded !== undefined && recorded.length > 0) {
      // Recorded by the server, whether or not we saw the ack.
      if (plan.state === 'sent') answerAccepted.add(true);
      this.cancel(plan.timer);
      plan.timer = null;
      plan.state = 'acked';
      return;
    }
    if (plan.state === 'planned' && plan.timer === null) {
      plan.timer = this.after(plan.at - Date.now(), () => this.fire(plan));
    } else if (plan.state === 'deferred' || (plan.state === 'sent' && plan.gen !== this.gen)) {
      // Waited out a disconnect, or sent on a socket that died before the server recorded it. An
      // answer sent on this very socket is left alone (a broadcast and a snapshot of the same
      // question can both arrive): its ack is on the way, and a second copy would only draw a
      // `duplicate`.
      plan.state = 'planned';
      this.fire(plan);
    }
  }

  choose(question) {
    const first = this.rng.chance(cfg.firstOptionShare);
    switch (question.type) {
      case 'single':
      case 'poll': {
        const option = first ? question.options[0] : this.rng.pick(question.options);
        return { kind: 'choice', optionId: option.id };
      }
      case 'truefalse':
        return { kind: 'boolean', value: first ? true : this.rng.chance(0.5) };
      default:
        return { kind: 'text', text: 'ok' };
    }
  }

  fire(plan) {
    plan.timer = null;
    if (plan.state !== 'planned') return;
    const sent = this.ready
      ? this.send({ type: 'answer', questionIndex: plan.index, payload: plan.payload })
      : false;
    if (sent) {
      plan.sentAt = Date.now();
      plan.gen = this.gen;
      plan.state = 'sent';
    } else {
      plan.state = 'deferred';
    }
  }

  onAck(message, receivedAt) {
    const plan = this.plans.get(message.index);
    // Already settled by the reveal or a snapshot: not a second observation.
    if (plan === undefined || plan.state !== 'sent') return;
    plan.state = 'acked';
    answerAck.add(receivedAt - plan.sentAt);
    const accepted = message.status === 'accepted' || message.status === 'duplicate';
    answerAccepted.add(accepted);
    if (!accepted) recordError(`answer-rejected-${message.reason ?? 'unknown'}`);
  }

  /** The question is over: an answer still waiting to be sent can no longer count. */
  closeOpenPlans(upToIndex) {
    for (const plan of this.plans.values()) {
      if (plan.index > upToIndex) continue;
      if (plan.state === 'planned' || plan.state === 'deferred') {
        this.cancel(plan.timer);
        plan.timer = null;
        plan.state = 'skipped';
        recordError('answer-skipped');
      }
    }
  }

  // ---------------------------------------------------------------------------------------
  // The one planned disconnect
  // ---------------------------------------------------------------------------------------

  maybeScheduleDrop(index) {
    if (index !== this.dropQuestion || this.dropScheduled || this.dropDone) return;
    this.dropScheduled = true;
    this.after(this.rng.range(...cfg.dropDelaySec) * 1000, () => this.drop());
  }

  drop() {
    if (!this.ready || this.ledger === null) {
      // Not connected right now (an unplanned close is being handled): do not add a second one.
      this.dropDone = true;
      return;
    }
    this.dropDone = true;
    this.ledger.disconnect();
    this.abandonSocket();
    this.resumeAttempt = 0;
    this.after(this.rng.range(...cfg.resumeDelaySec) * 1000, () => this.resume());
  }

  // ---------------------------------------------------------------------------------------
  // End of the game
  // ---------------------------------------------------------------------------------------

  finish(reason) {
    if (this.finished) return;
    this.finished = true;
    for (const id of this.timers) clearTimeout(id);
    this.timers.clear();
    // Every answer that was sent, or was meant to be sent, ends up as one observation. Whatever is
    // still open here never got an outcome: not accepted. Without this a server that silently drops
    // answers or acks could not fail the `zq_answer_accepted` gate.
    for (const plan of this.plans.values()) {
      if (plan.state === 'sent') {
        // Sent, and neither an ack nor a later reveal or snapshot said what became of it.
        recordError('ack-timeout');
        answerAccepted.add(false);
      } else if (plan.state === 'deferred') {
        // Due while the socket was down, and no resume got the player back before the game ended
        // for it (otherwise closeOpenPlans or a re-fire would have settled the plan).
        recordError('answer-undelivered');
        answerAccepted.add(false);
      }
    }
    if (this.ledger !== null) this.settle();
    const ws = this.ws;
    this.ws = null;
    if (ws !== null) closeSocket(ws, reason);
  }

  settle() {
    const result = this.ledger.settle();
    for (const type of MESSAGE_TYPES) {
      const counts = result.byType[type];
      msgExpected.add(counts.expected, { type });
      msgReceived.add(counts.received, { type });
      msgMissedWhileDisconnected.add(counts.missed, { type });
    }
    msgDuplicate.add(result.duplicates);
    msgViaSnapshot.add(result.viaSnapshot);
  }
}
