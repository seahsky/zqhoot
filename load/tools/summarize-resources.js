// Reduces the sampler's CSV to peaks and averages, prints them, and stores them under
// `resources` in the run's results JSON.
//
//   node load/tools/summarize-resources.js CSV RESULTS_JSON [--loadavg-before "…"] [--loadavg-after "…"]

import { readFileSync, writeFileSync, existsSync } from 'node:fs';

const [csvPath, jsonPath, ...rest] = process.argv.slice(2);
if (csvPath === undefined || jsonPath === undefined) {
  console.error(
    'usage: summarize-resources.js CSV RESULTS_JSON [--loadavg-before S] [--loadavg-after S]',
  );
  process.exit(2);
}
const option = (name) => {
  const at = rest.indexOf(name);
  return at === -1 ? null : rest[at + 1];
};

const [headerLine, ...lines] = readFileSync(csvPath, 'utf8').trim().split('\n');
const header = headerLine.split(',');
const rows = lines.map((line) => line.split(','));
const column = (name) =>
  rows
    .map((r) => r[header.indexOf(name)])
    .filter((v) => v !== undefined && v !== '')
    .map(Number);
const max = (xs) => (xs.length === 0 ? null : Math.max(...xs));
const mean = (xs) => (xs.length === 0 ? null : xs.reduce((a, b) => a + b, 0) / xs.length);
const percentile = (xs, p) => {
  if (xs.length === 0) return null;
  const sorted = [...xs].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)];
};
const round = (x, d = 1) => (x === null ? null : Math.round(x * 10 ** d) / 10 ** d);

const names = header
  .filter((h) => h.endsWith('_cpu_pct') && h !== 'system_cpu_pct')
  .map((h) => h.slice(0, -'_cpu_pct'.length));

// k6 spends its first seconds building 401 JavaScript runtimes, which looks like a CPU peak that
// has nothing to do with the game; report the peak without them as well.
const WARMUP_SEC = 5;
const times = column('t_s');
const steady = (name) =>
  rows
    .filter((_, i) => times[i] > WARMUP_SEC)
    .map((r) => r[header.indexOf(name)])
    .filter((v) => v !== undefined && v !== '')
    .map(Number);

const processes = {};
for (const name of names) {
  const cpu = column(`${name}_cpu_pct`);
  processes[name] = {
    peakCpuPct: round(max(cpu)),
    peakCpuPctAfterWarmup: round(max(steady(`${name}_cpu_pct`))),
    p95CpuPct: round(percentile(cpu, 95)),
    avgCpuPct: round(mean(cpu)),
    peakRssMb: round(max([...column(`${name}_rss_mb`), ...column(`${name}_hwm_mb`)])),
    peakFds: max(column(`${name}_fds`)),
    peakThreads: max(column(`${name}_threads`)),
  };
}

const load = column('loadavg1');
const resources = {
  sampleIntervalMs: 1000,
  samples: rows.length,
  durationSec: round(max(column('t_s')), 0),
  note: `CPU is percent of one core (400 = four busy cores), sampled from /proc once a second. "AfterWarmup" leaves out the first ${WARMUP_SEC} s.`,
  processes,
  system: {
    peakCpuPctOfAllCores: round(max(column('system_cpu_pct'))),
    avgCpuPctOfAllCores: round(mean(column('system_cpu_pct'))),
  },
  loadavg: {
    before: option('--loadavg-before'),
    after: option('--loadavg-after'),
    peak1: round(max(load), 2),
    mean1: round(mean(load), 2),
  },
};

if (existsSync(jsonPath)) {
  const results = JSON.parse(readFileSync(jsonPath, 'utf8'));
  results.resources = resources;
  writeFileSync(jsonPath, `${JSON.stringify(results, null, 2)}\n`);
}

const pad = (v, w) => String(v ?? '-').padStart(w);
console.log('resources (1 s samples; CPU in % of one core)');
console.log(
  `  ${'process'.padEnd(16)}${pad('peak cpu', 10)}${pad('after 5s', 10)}${pad('p95 cpu', 10)}${pad('avg cpu', 10)}${pad('peak rss', 11)}${pad('peak fds', 10)}`,
);
for (const [name, p] of Object.entries(processes)) {
  console.log(
    `  ${name.padEnd(16)}${pad(p.peakCpuPct, 10)}${pad(p.peakCpuPctAfterWarmup, 10)}${pad(p.p95CpuPct, 10)}${pad(p.avgCpuPct, 10)}${pad(`${p.peakRssMb} MB`, 11)}${pad(p.peakFds, 10)}`,
  );
}
console.log(
  `  machine: ${resources.system.avgCpuPctOfAllCores}% of all cores on average, ${resources.system.peakCpuPctOfAllCores}% peak; ` +
    `load average ${resources.loadavg.before ?? '?'} before, ${resources.loadavg.after ?? '?'} after`,
);
