// Minimal leveled logger for structured, parseable operational output
// (WP3). No external dependency: each call emits one line of JSON to
// stdout (info) or stderr (warn/error) shaped as
// `{ ts, level, msg, ...meta }`. Filtering is controlled by
// PROMPTWORKSPACE_LOG_LEVEL (default "info"): "error" shows only errors,
// "warn" shows warnings and errors, "info" (default) shows everything.
type Level = "info" | "warn" | "error";

const LEVEL_ORDER: Record<Level, number> = { error: 0, warn: 1, info: 2 };

function configuredLevel(): Level {
  const raw = process.env.PROMPTWORKSPACE_LOG_LEVEL;
  if (raw === "error" || raw === "warn" || raw === "info") return raw;
  return "info";
}

function emit(level: Level, msg: string, meta?: Record<string, unknown>): void {
  if (LEVEL_ORDER[level] > LEVEL_ORDER[configuredLevel()]) return;
  const line = JSON.stringify({ ts: new Date().toISOString(), level, msg, ...meta });
  if (level === "info") {
    process.stdout.write(line + "\n");
  } else {
    process.stderr.write(line + "\n");
  }
}

export const log = {
  info: (msg: string, meta?: Record<string, unknown>) => emit("info", msg, meta),
  warn: (msg: string, meta?: Record<string, unknown>) => emit("warn", msg, meta),
  error: (msg: string, meta?: Record<string, unknown>) => emit("error", msg, meta),
};
