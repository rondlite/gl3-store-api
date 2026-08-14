export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const RANK: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export type Logger = Record<LogLevel, (msg: string, fields?: Record<string, unknown>) => void>;

/**
 * JSON lines on stdout. Deliberately not a logging library: this service emits
 * request lines and errors, and nothing about that needs transports, child
 * loggers, or serializers.
 *
 * Nothing here ever receives a token or the internal API key -- request logging
 * records the method, path and status only, never headers or bodies.
 */
export function createLogger(level: LogLevel = 'info'): Logger {
  const threshold = RANK[level];

  const emit =
    (at: LogLevel) =>
    (msg: string, fields: Record<string, unknown> = {}): void => {
      if (RANK[at] < threshold) {
        return;
      }
      console.log(JSON.stringify({ at, time: new Date().toISOString(), msg, ...fields }));
    };

  return { debug: emit('debug'), info: emit('info'), warn: emit('warn'), error: emit('error') };
}

/** Drops everything. Used by tests so a passing run stays quiet. */
export function silentLogger(): Logger {
  const noop = (): void => {};
  return { debug: noop, info: noop, warn: noop, error: noop };
}
