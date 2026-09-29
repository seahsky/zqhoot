// k6 load test for one zqhoot quiz session: a host and ZQ_PLAYERS phones, ADR-0014.
//
//   ZQ_BASE_URL=http://127.0.0.1:8080 ZQ_PASSWORD=... k6 run load/zqhoot.js
//
// The target is selected by environment variables only (see load/README.md and lib/config.js), so
// the same script runs against the Node server, the Lambda emulator and a deployed AWS stack.

import { cfg } from './lib/config.js';
import { createQuizAndSession, discoverEndpoints, hostToken } from './lib/api.js';
import { runHost } from './lib/host.js';
import { buildThresholds } from './lib/metrics.js';
import { runPlayer } from './lib/player.js';
import { buildQuiz, scoredFlags } from './lib/quiz.js';
import { buildSummary } from './lib/summary.js';

const maxDuration = `${cfg.budgetSec + 30}s`;

export const options = {
  scenarios: {
    host: {
      executor: 'shared-iterations',
      exec: 'host',
      vus: 1,
      iterations: 1,
      maxDuration,
      gracefulStop: '10s',
    },
    players: {
      executor: 'per-vu-iterations',
      exec: 'player',
      vus: cfg.players,
      iterations: 1,
      maxDuration,
      gracefulStop: '30s',
    },
  },
  thresholds: buildThresholds(cfg.questions),
  summaryTrendStats: ['min', 'avg', 'p(50)', 'p(90)', 'p(95)', 'p(99)', 'max', 'count'],
};

export function setup() {
  const { apiUrl, wsUrl } = discoverEndpoints();
  const token = hostToken(apiUrl);
  const quiz = buildQuiz(cfg);
  const session = createQuizAndSession(apiUrl, token, quiz);
  console.log(
    `zq-setup: session ${session.sessionId} pin ${session.pin}, ${quiz.questions.length} questions, ws ${wsUrl}`,
  );
  return {
    apiUrl,
    wsUrl,
    token,
    sessionId: session.sessionId,
    pin: session.pin,
    scored: scoredFlags(quiz),
  };
}

export function host(data) {
  runHost(data);
}

export function player(data) {
  runPlayer(data);
}

export function handleSummary(data) {
  const summary = buildSummary(data);
  return { [summary.file]: summary.json, stdout: summary.text };
}
