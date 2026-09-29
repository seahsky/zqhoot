// Prints the Markdown for one or more results files, in the layout of load/RESULTS.md, so a rerun
// can be pasted in without retyping numbers.
//
//   node load/tools/results-table.js load/results/20260929T074138Z-node.json [...]

import { readFileSync } from 'node:fs';

const files = process.argv.slice(2);
if (files.length === 0) {
  console.error('usage: results-table.js RESULTS_JSON [RESULTS_JSON ...]');
  process.exit(2);
}

const TYPES = ['question', 'reveal', 'leaderboard', 'ended'];
const STEPS = ['open-first', 'open-next', 'close-reveal', 'reveal-leaderboard', 'end'];

const int = (n) => (n === null || n === undefined ? '-' : Number(n).toLocaleString('en-US'));
const ms = (n) => (n === null || n === undefined ? '-' : String(n));
const pct = (rate, digits = 2) =>
  rate === null || rate === undefined
    ? 'n/a'
    : `${Math.round(rate * 10 ** (digits + 2)) / 10 ** digits}%`;
const table = (rows) => rows.map((r) => `| ${r.join(' | ')} |`).join('\n');

function block(file) {
  const { meta, derived: d, resources: r } = JSON.parse(readFileSync(file, 'utf8'));
  const c = meta.config;
  const out = [];
  const dropped = Math.round(c.players * c.reconnectRatio);
  out.push(`#### ${meta.runId}`);
  out.push('');
  out.push(
    table([
      ['Item', 'Value'],
      ['---', '---'],
      ['Finished', meta.finishedAt],
      ['Commit', `\`${meta.commit}\``],
      ['Target', meta.target],
      ['Machine', meta.machine],
      [
        'Load average (1, 5, 15 min, running/total) before / after',
        r === undefined ? '-' : `${r.loadavg.before} / ${r.loadavg.after}`,
      ],
      [
        'Machine CPU during the run (all 4 cores)',
        r === undefined
          ? '-'
          : `${r.system.avgCpuPctOfAllCores}% average, ${r.system.peakCpuPctOfAllCores}% peak; load average peaked at ${r.loadavg.peak1}`,
      ],
      [
        'Players / questions / reconnect ratio',
        `${c.players} / ${c.questions} / ${c.reconnectRatio} (${dropped} players)`,
      ],
      [
        'Answer think time',
        `median ${c.answerMedianSec} s, sigma ${c.answerSigma}, limit ${c.timeLimit} s`,
      ],
      ['Duration', `${d.durationSec} s (room full after ${ms(d.joinPhase.max)} ms)`],
      ['Join success', `${pct(d.join.rate)} (${d.join.passes} of ${d.join.passes + d.join.fails})`],
      [
        'Resume success',
        `${pct(d.resume.rate)} (${d.resume.passes} of ${d.resume.passes + d.resume.fails} attempts)`,
      ],
      [
        'Delivery (received / expected)',
        `${pct(d.delivery.rate, 3)} (${int(d.delivery.received)} of ${int(d.delivery.expected)}; lost ${int(d.delivery.lost)}, missed while disconnected ${int(d.delivery.missedWhileDisconnected)}, duplicates ${int(d.delivery.duplicates)}, received via snapshot ${int(d.delivery.receivedViaSnapshot)})`,
      ],
      [
        'Answers accepted',
        `${pct(d.accepted.rate)} (${int(d.accepted.passes)} of ${int(d.accepted.passes + d.accepted.fails)})`,
      ],
      [
        'Errors by code',
        d.errors.total === 0
          ? 'none'
          : Object.entries(d.errors.byCode)
              .map(([code, n]) => `${code} ${n}`)
              .join(', '),
      ],
      [
        'Gates',
        d.gates
          .map(
            (g) =>
              `${g.metric} ${g.pass === null ? 'n/a (no samples)' : g.pass ? 'met' : g.gate ? 'MISSED' : 'missed (reported)'}`,
          )
          .join('; '),
      ],
    ]),
  );
  out.push('');
  const row = (label, t) => [label, int(t.count), ms(t.p50), ms(t.p95), ms(t.p99), ms(t.max)];
  out.push(
    table([
      ['Latency (ms)', 'n', 'p50', 'p95', 'p99', 'max'],
      ['---', '---:', '---:', '---:', '---:', '---:'],
      ...TYPES.map((t) => row(`broadcast \`${t}\``, d.broadcastLatency[t])),
      row('answer ack', d.answerAck),
      row('question margin before `openAt`', d.questionMargin),
      ...STEPS.filter((s) => d.hostTransitions[s].count > 0).map((s) =>
        row(`host \`${s}\``, d.hostTransitions[s]),
      ),
    ]),
  );
  if (r !== undefined) {
    out.push('');
    out.push(
      table([
        [
          'Process',
          'peak CPU %',
          'peak CPU % after 5 s',
          'p95 CPU %',
          'avg CPU %',
          'peak RSS MB',
          'peak fds',
        ],
        ['---', '---:', '---:', '---:', '---:', '---:', '---:'],
        ...Object.entries(r.processes).map(([name, p]) => [
          name,
          p.peakCpuPct,
          p.peakCpuPctAfterWarmup,
          p.p95CpuPct,
          p.avgCpuPct,
          p.peakRssMb,
          p.peakFds,
        ]),
      ]),
    );
  }
  return out.join('\n');
}

console.log(files.map(block).join('\n\n'));
