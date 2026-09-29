import type { Logger } from '@zqhoot/service';
import { LOG_LEVELS } from './config.ts';
import type { LogLevel } from './config.ts';

type Sink = Pick<Console, LogLevel>;

function serialize(level: LogLevel, o: object, message: string | undefined): string {
  try {
    return JSON.stringify({ ...o, level, ...(message !== undefined ? { msg: message } : {}) });
  } catch {
    // A circular object in a log call must not take the request down with it.
    return JSON.stringify({ level, msg: message, unserializable: true });
  }
}

/**
 * One JSON object per line. The Lambda runtime prefixes each console call with its own timestamp
 * and request id, so the record carries neither.
 */
export function createLogger(level: LogLevel, sink: Sink = console): Logger {
  const threshold = LOG_LEVELS.indexOf(level);
  const at =
    (name: LogLevel) =>
    (o: object, message?: string): void => {
      if (LOG_LEVELS.indexOf(name) < threshold) return;
      sink[name](serialize(name, o, message));
    };
  return { debug: at('debug'), info: at('info'), warn: at('warn'), error: at('error') };
}
