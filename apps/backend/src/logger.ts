/**
 * Minimal structured logger. A real deployment would swap this for pino, but for
 * a prototype a timestamped JSON line keeps the demo readable and greppable
 * without pulling in a dependency.
 */
type Level = "info" | "warn" | "error";

function emit(level: Level, msg: string, meta?: Record<string, unknown>) {
  const line = { t: new Date().toISOString(), level, msg, ...meta };
  const text = JSON.stringify(line);
  if (level === "error") console.error(text);
  else if (level === "warn") console.warn(text);
  else console.log(text);
}

export const log = {
  info: (msg: string, meta?: Record<string, unknown>) => emit("info", msg, meta),
  warn: (msg: string, meta?: Record<string, unknown>) => emit("warn", msg, meta),
  error: (msg: string, meta?: Record<string, unknown>) => emit("error", msg, meta),
};
