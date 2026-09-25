/**
 * Structured JSON logger. Every pipeline log line carries a `stage` that matches the
 * PipelineStage enum persisted in the database, so logs and records can be joined.
 * Secrets are redacted by key name and by value (any configured secret env value).
 */

type Level = "debug" | "info" | "warn" | "error";
type Fields = Record<string, unknown>;

const SECRET_KEY = /(key|secret|token|password|authorization|cookie|credential|assertion|private)/i;
const SECRET_ENV = [
  "CONTENT_API_KEY",
  "SOVRN_API_KEY",
  "SOVRN_SITE_KEY",
  "IMAGE_ENRICHMENT_API_KEY",
  "ADMIN_PASSWORD",
  "ADMIN_SESSION_SECRET",
  "CRON_SECRET",
  "GSC_SERVICE_ACCOUNT_JSON",
  "DATABASE_URL",
];

function secretValues(): string[] {
  return SECRET_ENV.map((name) => process.env[name]).filter((v): v is string => Boolean(v && v.length >= 6));
}

export function redactString(value: string): string {
  let out = value;
  for (const secret of secretValues()) out = out.split(secret).join("[REDACTED]");
  // Never log credentials embedded in URLs.
  return out.replace(/\/\/([^/@\s:]+):([^/@\s]+)@/g, "//[REDACTED]@");
}

export function redact(value: unknown, depth = 0): unknown {
  if (depth > 6) return "[TRUNCATED]";
  if (typeof value === "string") return redactString(value);
  if (value instanceof Error) return { name: value.name, message: redactString(value.message) };
  if (Array.isArray(value)) return value.slice(0, 50).map((v) => redact(v, depth + 1));
  if (value && typeof value === "object") {
    const out: Fields = {};
    for (const [k, v] of Object.entries(value as Fields)) out[k] = SECRET_KEY.test(k) ? "[REDACTED]" : redact(v, depth + 1);
    return out;
  }
  return value;
}

function emit(level: Level, message: string, fields: Fields = {}) {
  if (process.env.LOG_SILENT === "1") return;
  const line = JSON.stringify({ ts: new Date().toISOString(), level, msg: message, ...(redact(fields) as Fields) });
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.log(line);
}

export const log = {
  debug: (msg: string, fields?: Fields) => process.env.LOG_LEVEL === "debug" && emit("debug", msg, fields),
  info: (msg: string, fields?: Fields) => emit("info", msg, fields),
  warn: (msg: string, fields?: Fields) => emit("warn", msg, fields),
  error: (msg: string, fields?: Fields) => emit("error", msg, fields),
};
