// Samples CPU and memory of the processes under test once a second into a CSV.
//
//   node load/tools/sample.js --out FILE [--interval MS] --proc server=PID --proc k6=PID ...
//
// Reads /proc/<pid>/stat (utime + stime) and /proc/<pid>/status, so it needs Linux and adds
// almost nothing to what it measures. CPU is a percentage of one core (400 is four busy cores).
// Stops on SIGTERM/SIGINT, or by itself when every process it watches has exited.

import { execFileSync } from 'node:child_process';
import { appendFileSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';

const args = process.argv.slice(2);
const option = (name) => {
  const at = args.indexOf(name);
  return at === -1 ? undefined : args[at + 1];
};
const optionAll = (name) => args.flatMap((a, i) => (a === name ? [args[i + 1]] : []));

const out = option('--out');
const intervalMs = Number(option('--interval') ?? 1000);
const procs = optionAll('--proc').map((spec) => {
  const [name, pid] = spec.split('=');
  return { name, pid: Number(pid), lastTicks: null, alive: true };
});
if (out === undefined || procs.length === 0 || procs.some((p) => !Number.isInteger(p.pid))) {
  console.error(
    'usage: sample.js --out FILE [--interval MS] --proc name=PID [--proc name=PID ...]',
  );
  process.exit(2);
}

const clockTicks = Number(execFileSync('getconf', ['CLK_TCK']).toString());
const readTicks = (pid) => {
  const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
  // The command name may contain spaces and parentheses; everything after the last ')' is fixed.
  const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
  return Number(fields[11]) + Number(fields[12]);
};
const readStatus = (pid) => {
  const status = readFileSync(`/proc/${pid}/status`, 'utf8');
  const kb = (key) => Number((new RegExp(`^${key}:\\s+(\\d+)`, 'm').exec(status) ?? [])[1] ?? 0);
  return { rssMb: kb('VmRSS') / 1024, hwmMb: kb('VmHWM') / 1024, threads: kb('Threads') };
};
const countFds = (pid) => {
  try {
    return readdirSync(`/proc/${pid}/fd`).length;
  } catch (err) {
    return 0;
  }
};
const systemBusy = () => {
  const cpu = readFileSync('/proc/stat', 'utf8')
    .split('\n')[0]
    .trim()
    .split(/\s+/)
    .slice(1)
    .map(Number);
  const idle = cpu[3] + (cpu[4] ?? 0);
  return { total: cpu.reduce((a, b) => a + b, 0), idle };
};

const header = ['t_s', 'loadavg1', 'system_cpu_pct'];
for (const p of procs)
  header.push(
    `${p.name}_cpu_pct`,
    `${p.name}_rss_mb`,
    `${p.name}_hwm_mb`,
    `${p.name}_fds`,
    `${p.name}_threads`,
  );
writeFileSync(out, `${header.join(',')}\n`);

const started = Date.now();
let lastAt = started;
let lastSystem = systemBusy();
readTicksInto(procs);

function readTicksInto(list) {
  for (const p of list) {
    try {
      p.lastTicks = readTicks(p.pid);
    } catch (err) {
      p.alive = false;
    }
  }
}

function sample() {
  const now = Date.now();
  const dt = (now - lastAt) / 1000;
  lastAt = now;
  const system = systemBusy();
  const busy = 1 - (system.idle - lastSystem.idle) / Math.max(1, system.total - lastSystem.total);
  lastSystem = system;
  const load1 = readFileSync('/proc/loadavg', 'utf8').split(' ')[0];
  const row = [((now - started) / 1000).toFixed(1), load1, (busy * 100).toFixed(1)];
  for (const p of procs) {
    if (!p.alive) {
      row.push('', '', '', '', '');
      continue;
    }
    try {
      const ticks = readTicks(p.pid);
      const cpu = p.lastTicks === null ? 0 : ((ticks - p.lastTicks) / clockTicks / dt) * 100;
      p.lastTicks = ticks;
      const mem = readStatus(p.pid);
      row.push(
        cpu.toFixed(1),
        mem.rssMb.toFixed(1),
        mem.hwmMb.toFixed(1),
        countFds(p.pid),
        mem.threads,
      );
    } catch (err) {
      p.alive = false;
      row.push('', '', '', '', '');
    }
  }
  appendFileSync(out, `${row.join(',')}\n`);
  if (procs.every((p) => !p.alive)) process.exit(0);
}

const timer = setInterval(sample, intervalMs);
const stop = () => {
  clearInterval(timer);
  sample();
  process.exit(0);
};
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
