import { cfg, publicConfig } from './config.js';
import { MESSAGE_TYPES } from './ledger.js';
import { ERROR_CODES, HOST_STEPS } from './metrics.js';
import { redactTokens, withoutSetupSecrets } from './redact.js';

const round = (value, digits = 2) =>
  typeof value === 'number' && Number.isFinite(value)
    ? Math.round(value * 10 ** digits) / 10 ** digits
    : null;

const valuesOf = (data, name) => {
  const metric = data.metrics[name];
  return metric === undefined ? {} : metric.values;
};

const countOf = (data, name) => valuesOf(data, name).count ?? 0;

function trendOf(data, name) {
  const v = valuesOf(data, name);
  return {
    count: v.count ?? 0,
    min: round(v.min),
    p50: round(v['p(50)']),
    p95: round(v['p(95)']),
    p99: round(v['p(99)']),
    max: round(v.max),
    avg: round(v.avg),
  };
}

function rateOf(data, name) {
  const v = valuesOf(data, name);
  const total = (v.passes ?? 0) + (v.fails ?? 0);
  return { rate: total === 0 ? null : v.rate, passes: v.passes ?? 0, fails: v.fails ?? 0 };
}

const timestamp = () =>
  new Date()
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d+Z$/, 'Z');

export function derive(data) {
  const join = rateOf(data, 'zq_join_success');
  const resume = rateOf(data, 'zq_resume_success');
  const accepted = rateOf(data, 'zq_answer_accepted');

  const expected = countOf(data, 'zq_msg_expected');
  const received = countOf(data, 'zq_msg_received');
  const deliveryByType = {};
  for (const type of MESSAGE_TYPES) {
    const e = countOf(data, `zq_msg_expected{type:${type}}`);
    const r = countOf(data, `zq_msg_received{type:${type}}`);
    deliveryByType[type] = {
      expected: e,
      received: r,
      missedWhileDisconnected: countOf(data, `zq_msg_missed_while_disconnected{type:${type}}`),
      rate: e === 0 ? null : round(r / e, 6),
    };
  }
  const delivery = {
    expected,
    received,
    lost: expected - received,
    rate: expected === 0 ? null : received / expected,
    missedWhileDisconnected: countOf(data, 'zq_msg_missed_while_disconnected'),
    duplicates: countOf(data, 'zq_msg_duplicate'),
    receivedViaSnapshot: countOf(data, 'zq_msg_via_snapshot'),
    byType: deliveryByType,
  };

  const broadcastLatency = {};
  for (const type of MESSAGE_TYPES) {
    broadcastLatency[type] = trendOf(data, `zq_broadcast_latency_ms{type:${type}}`);
  }
  const hostTransitions = {};
  for (const step of HOST_STEPS) {
    hostTransitions[step] = trendOf(data, `zq_host_transition_ms{step:${step}}`);
  }

  // Every host transition in order: which question, which step, how long it took.
  const hostTimeline = [];
  for (let q = 0; q < cfg.questions; q++) {
    for (const step of HOST_STEPS) {
      const t = trendOf(data, `zq_host_transition_ms{step:${step},q:${q}}`);
      if (t.count > 0) hostTimeline.push({ q, step, ms: t.max });
    }
  }

  const errorsByCode = {};
  let listed = 0;
  for (const code of ERROR_CODES) {
    const count = countOf(data, `zq_errors{code:${code}}`);
    if (count > 0) errorsByCode[code] = count;
    listed += count;
  }
  const errorTotal = countOf(data, 'zq_errors');
  if (errorTotal > listed) errorsByCode.other = errorTotal - listed;

  const gates = [
    { metric: 'zq_join_success', rule: '> 99.5%', value: join.rate, target: 0.995, gate: true },
    { metric: 'zq_answer_accepted', rule: '> 99%', value: accepted.rate, target: 0.99, gate: true },
    {
      metric: 'zq_msg_received / zq_msg_expected',
      rule: '> 99.5%',
      value: delivery.rate,
      target: 0.995,
      gate: false,
    },
    // A metric with no samples is not a failure: k6 passes its threshold too, so the verdict says n/a.
  ].map((g) => ({ ...g, pass: g.value === null ? null : g.value > g.target }));

  return {
    durationSec: round((data.state?.testRunDurationMs ?? 0) / 1000, 1),
    join,
    resume,
    accepted,
    delivery,
    broadcastLatency,
    answerAck: trendOf(data, 'zq_answer_ack_ms'),
    questionMargin: trendOf(data, 'zq_question_margin_ms'),
    joinPhase: trendOf(data, 'zq_join_phase_ms'),
    hostTransitions,
    hostTimeline,
    errors: { total: errorTotal, byCode: errorsByCode },
    gates,
  };
}

const pct = (value, digits = 2) => (value === null ? 'n/a' : `${round(value * 100, digits)}%`);
const num = (value) => (value === null || value === undefined ? '-' : String(value));

function renderText(meta, d) {
  const lines = [];
  const out = (line = '') => lines.push(line);
  const cell = (value, width) => String(value).padStart(width);
  out('');
  out(
    `zqhoot load test  target=${meta.target}  players=${cfg.players}  questions=${cfg.questions}` +
      `  reconnect=${round(cfg.reconnectRatio * 100, 1)}%  duration=${d.durationSec}s`,
  );
  out('');
  for (const g of d.gates) {
    const verdict =
      g.pass === null
        ? 'n/a (no samples)'
        : g.pass
          ? 'PASS'
          : g.gate
            ? 'FAIL (gate)'
            : 'MISS (reported)';
    out(`  ${g.metric.padEnd(36)} ${pct(g.value).padStart(8)}   ${g.rule.padEnd(8)} ${verdict}`);
  }
  out(
    `  zq_resume_success                    ${pct(d.resume.rate).padStart(8)}` +
      `   (${d.resume.passes} of ${d.resume.passes + d.resume.fails} attempts)`,
  );
  out(
    `  messages: expected ${d.delivery.expected}, received ${d.delivery.received}, ` +
      `lost ${d.delivery.lost}, missed while disconnected ${d.delivery.missedWhileDisconnected}, ` +
      `duplicates ${d.delivery.duplicates}`,
  );
  out('');
  out(
    `  ${'latency (ms)'.padEnd(22)}${['n', 'p50', 'p95', 'p99', 'max'].map((h) => cell(h, 9)).join('')}`,
  );
  const row = (label, t) =>
    out(
      `  ${label.padEnd(22)}${[t.count, t.p50, t.p95, t.p99, t.max].map((x) => cell(num(x), 9)).join('')}`,
    );
  for (const type of MESSAGE_TYPES) row(`broadcast ${type}`, d.broadcastLatency[type]);
  row('answer ack', d.answerAck);
  row('question margin', d.questionMargin);
  for (const step of HOST_STEPS) row(`host ${step}`, d.hostTransitions[step]);
  out('');
  const codes = Object.entries(d.errors.byCode)
    .map(([code, count]) => `${code}=${count}`)
    .join(' ');
  out(`  errors: ${d.errors.total}${codes === '' ? '' : `  (${codes})`}`);
  out('');
  return lines.join('\n');
}

/** The file k6 writes and the table it prints. */
export function buildSummary(data) {
  const runId = cfg.runId === '' ? `${timestamp()}-${cfg.target}` : cfg.runId;
  const d = derive(data);
  const meta = {
    runId,
    target: cfg.target,
    finishedAt: new Date().toISOString(),
    commit: cfg.commit,
    machine: cfg.machine,
    config: publicConfig(),
  };
  // `data.setup_data` holds the host's bearer token, and this file is meant to be committed.
  const body = JSON.stringify({ meta, derived: d, k6: withoutSetupSecrets(data) }, null, 2);
  return {
    file: `${cfg.resultsDir}/${runId}.json`,
    json: `${redactTokens(body, [cfg.hostToken])}\n`,
    text: renderText(meta, d),
  };
}
