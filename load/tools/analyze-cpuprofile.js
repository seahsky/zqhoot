// Summarises a Node `--cpu-prof` profile: how busy the event loop was each second, and where the
// busy time of the busiest seconds went.
//
//   ZQ_SERVER_NODE_ARGS="--cpu-prof --cpu-prof-dir=$PWD/load/results/raw/prof" \
//     ZQ_QUESTIONS=2 ZQ_ANSWER_MEDIAN_SEC=0.4 ZQ_ANSWER_SIGMA=0 ZQ_RUN_LABEL=profile \
//     load/run-local.sh lambda-emulator
//   node load/tools/analyze-cpuprofile.js load/results/raw/prof/CPU.*.cpuprofile [--busy=0.9 | --seconds=23,24]
//
// The emulator bundles the AWS SDK into the handler bundle, so SDK code and game code both show
// up as "handler bundle".

import { readFileSync } from 'node:fs';

const args = process.argv.slice(2);
const file = args.find((a) => !a.startsWith('--'));
const flag = (name) => args.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
const BUSY_THRESHOLD = Number(flag('busy') ?? 0.9);
const CHOSEN = flag('seconds')?.split(',').map(Number);
if (file === undefined) {
  console.error(
    'usage: analyze-cpuprofile.js FILE.cpuprofile [--busy=0.9 | --seconds=23,24,30,31]',
  );
  process.exit(2);
}

const profile = JSON.parse(readFileSync(file, 'utf8'));
const nodes = new Map(profile.nodes.map((n) => [n.id, n]));

const label = (node) => {
  const { url, functionName } = node.callFrame;
  if (functionName === '(garbage collector)') return 'garbage collection';
  if (functionName === '(program)') return 'other (program)';
  if (functionName === 'writev') return 'socket writes (writev)';
  if (url === '') return 'other native code';
  if (url.startsWith('node:')) return 'node internals (http, crypto, streams)';
  if (/\/dist\/(ws|http)\/index\.mjs$/.test(url)) return 'handler bundle (game code + AWS SDK)';
  if (url.includes('/dist/emulator/')) return 'emulator gateway';
  return url.replace(/.*\/node_modules\//, '');
};

const perSecond = new Map();
const samples = [];
let elapsedMs = 0;
profile.samples.forEach((id, i) => {
  const dt = profile.timeDeltas[i] / 1000;
  elapsedMs += dt;
  const node = nodes.get(id);
  const idle = node.callFrame.functionName === '(idle)';
  const second = Math.floor(elapsedMs / 1000);
  const bucket = perSecond.get(second) ?? { busy: 0, idle: 0 };
  bucket[idle ? 'idle' : 'busy'] += dt;
  perSecond.set(second, bucket);
  samples.push({ second, dt, node, idle });
});

const busyShare = (b) => b.busy / (b.busy + b.idle);
console.log('event loop busy per second (%):');
console.log([...perSecond].map(([s, b]) => `${s}:${Math.round(busyShare(b) * 100)}`).join(' '));
const hot = new Set(
  CHOSEN ?? [...perSecond].filter(([, b]) => busyShare(b) >= BUSY_THRESHOLD).map(([s]) => s),
);
console.log(
  CHOSEN === undefined
    ? `\nseconds at least ${BUSY_THRESHOLD * 100}% busy: ${[...hot].join(', ') || 'none'}`
    : `\nchosen seconds: ${[...hot].join(', ')}`,
);

const bySource = new Map();
let total = 0;
for (const s of samples) {
  if (s.idle || !hot.has(s.second)) continue;
  const key = label(s.node);
  bySource.set(key, (bySource.get(key) ?? 0) + s.dt);
  total += s.dt;
}
console.log(`\nbusy time in those seconds: ${Math.round(total)} ms`);
for (const [key, ms] of [...bySource].sort((a, b) => b[1] - a[1]).slice(0, 8)) {
  console.log(
    `${String(Math.round(ms)).padStart(7)} ms ${String(Math.round((ms / total) * 100)).padStart(4)}%  ${key}`,
  );
}
