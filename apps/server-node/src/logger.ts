import type { Logger } from '@zqhoot/service';

export const LOG_LEVELS = ['debug', 'info', 'warn', 'error', 'silent'] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

const RANK: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3, silent: 4 };

export type LogWriter = (level: Exclude<LogLevel, 'silent'>, line: string) => void;

const defaultWriter: LogWriter = (level, line) => {
  // Warnings and errors go to stderr so a supervisor can route them apart; both reach the container log.
  (level === 'warn' || level === 'error' ? process.stderr : process.stdout).write(`${line}\n`);
};

/** One JSON object per line. The core fields win over same-named keys in the logged object. */
export function createLogger(level: LogLevel, write: LogWriter = defaultWriter): Logger {
  const emit = (at: Exclude<LogLevel, 'silent'>, object: object, msg?: string): void => {
    if (RANK[at] < RANK[level]) return;
    const core = { level: at, time: new Date().toISOString(), msg };
    // Core fields first for readability; the second `core` makes them win over same-named keys.
    const record = Object.assign({}, core, object, core);
    let line: string;
    try {
      line = JSON.stringify(record);
    } catch {
      line = JSON.stringify({ level: at, time: record.time, msg, logError: 'unserialisable' });
    }
    write(at, line);
  };
  return {
    debug: (o, m) => emit('debug', o, m),
    info: (o, m) => emit('info', o, m),
    warn: (o, m) => emit('warn', o, m),
    error: (o, m) => emit('error', o, m),
  };
}
