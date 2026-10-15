/** Minimal structured logger. Never throws, so it is safe inside workers. */

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 } as const;
export type LogLevel = keyof typeof LEVELS;

const configured =
  (process.env.LOG_LEVEL as LogLevel | undefined) &&
  process.env.LOG_LEVEL! in LEVELS
    ? (process.env.LOG_LEVEL as LogLevel)
    : "info";

function emit(level: LogLevel, scope: string, msg: string, meta?: unknown) {
  if (LEVELS[level] < LEVELS[configured]) return;
  const line = {
    ts: new Date().toISOString(),
    level,
    scope,
    msg,
    ...(meta !== undefined ? { meta } : {}),
  };
  const text = JSON.stringify(line);
  if (level === "error") process.stderr.write(text + "\n");
  else process.stdout.write(text + "\n");
}

export function createLogger(scope: string) {
  return {
    debug: (msg: string, meta?: unknown) => emit("debug", scope, msg, meta),
    info: (msg: string, meta?: unknown) => emit("info", scope, msg, meta),
    warn: (msg: string, meta?: unknown) => emit("warn", scope, msg, meta),
    error: (msg: string, meta?: unknown) => emit("error", scope, msg, meta),
  };
}

export type Logger = ReturnType<typeof createLogger>;
