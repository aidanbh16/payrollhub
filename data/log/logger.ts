import "server-only";
import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { formatWithOptions } from "node:util";

// The central log pipeline (Assignment 5, Section 2.5; L2-12; D14). Every log line PayrollHub writes goes through
// here: application code may not call console.* (ESLint), and installConsoleRedaction() routes whatever still reaches
// the console (Next.js's own error output, dependencies) through the same redaction. Redaction happens at ingest,
// before anything is written:
//   1. by field name: any key in SENSITIVE_FIELDS (the shared logging schema), at any depth, is replaced whole;
//   2. by pattern, on every string (messages, error messages, stack traces, nested values, console text):
//      SSNs, 9-digit runs (routing numbers, unformatted SSNs), and any longer or grouped digit run (account numbers,
//      ACH entry records). UUIDs are left intact so request and record ids stay usable.
// Lines are structured JSON, appended to LOG_DIR/payrollhub.log (opened in append mode only; nothing here truncates,
// rewrites, or deletes), and mirrored, redacted, to the console.

/** The shared logging schema: field names whose values are never logged (compared case- and separator-insensitively). */
export const SENSITIVE_FIELDS = [
  "accountNumber", "routingNumber", "newAccountNumber", "newRoutingNumber", "ssn", "socialSecurityNumber", "taxId",
  "fileBody", "achFile", "password", "passwordHash", "totpSecret", "secret", "token", "approvalToken", "serviceToken",
  "authorization", "cookie", "setCookie", "assertion", "privateKey", "fieldEncryptionKey",
] as const;

const REDACTED = "[REDACTED]";
const normalizeKey = (key: string) => key.toLowerCase().replace(/[^a-z0-9]/g, "");
const SENSITIVE = new Set(SENSITIVE_FIELDS.map(normalizeKey));

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
const SSN = /(?<!\d)\d{3}[- ]\d{2}[- ]\d{4}(?!\d)/g;
// Digit groups separated by single spaces or dashes ("7301 0000 0101"); every group at least 3 digits, so dates
// (2026-10-16) and times are left alone.
const GROUPED = /(?<![\d-])\d{3,}(?:[ -]\d{3,})+(?![\d-]?\d)/g;
const DIGIT_RUN = /(?<!\d)\d{7,}(?!\d)/g;

function isAbaRoutingNumber(v: string): boolean {
  const d = [...v].map(Number);
  return v.length === 9 && (3 * (d[0] + d[3] + d[6]) + 7 * (d[1] + d[4] + d[7]) + (d[2] + d[5] + d[8])) % 10 === 0;
}

function redactSegment(text: string): string {
  return text
    .replace(SSN, "[SSN]")
    .replace(GROUPED, (m) => (m.replace(/\D/g, "").length >= 7 ? REDACTED : m))
    .replace(DIGIT_RUN, (m) => (m.length === 9 && isAbaRoutingNumber(m) ? "[ROUTING]" : REDACTED));
}

/** Pattern redaction for free text. Applied to every string that reaches a log. */
export function redactText(text: string): string {
  let out = "";
  let last = 0;
  for (const m of text.matchAll(UUID)) {
    out += redactSegment(text.slice(last, m.index)) + m[0];
    last = m.index + m[0].length;
  }
  return out + redactSegment(text.slice(last));
}

/** Field and pattern redaction for any value: nested objects, arrays, errors (message, stack, cause, own fields). */
export function redact(value: unknown, depth = 0, seen = new WeakSet<object>()): unknown {
  if (typeof value === "string") return redactText(value);
  if (typeof value === "number" || typeof value === "bigint") return redactText(String(value)) === String(value) ? value : REDACTED;
  if (value === null || typeof value !== "object") return value;
  if (seen.has(value)) return "[Circular]";
  if (depth > 8) return "[Truncated]";
  seen.add(value);
  if (value instanceof Date) return value.toISOString();
  if (Buffer.isBuffer(value) || value instanceof Uint8Array) return `[binary ${value.byteLength} bytes]`;
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1, seen));
  const out: Record<string, unknown> = {};
  if (value instanceof Error) {
    out.name = value.name;
    out.message = redactText(value.message);
    if (value.stack) out.stack = redactText(value.stack);
    if (value.cause !== undefined) out.cause = redact(value.cause, depth + 1, seen);
  }
  for (const [key, v] of Object.entries(value)) {
    out[key] = SENSITIVE.has(normalizeKey(key)) ? REDACTED : redact(v, depth + 1, seen);
  }
  return out;
}

type Level = "debug" | "info" | "warn" | "error";

type ConsoleMethod = "log" | "info" | "warn" | "error" | "debug";
const METHODS: ConsoleMethod[] = ["log", "info", "warn", "error", "debug"];

// The real console methods, captured when installConsoleRedaction() wraps the console, so the logger's own mirror is
// not ingested twice. Before that (scripts, tests), the logger writes to whatever console is current. Kept on a
// process-wide global, not in module state: Next.js bundles this module separately for instrumentation and for the
// routes, and every copy must see the one installed wrapper.
type RawConsole = Record<ConsoleMethod, (...args: unknown[]) => void>;
const RAW_CONSOLE = Symbol.for("payrollhub.log.rawConsole");
const shared = globalThis as typeof globalThis & { [RAW_CONSOLE]?: RawConsole };
const out = (method: ConsoleMethod, text: string) => (shared[RAW_CONSOLE] ? shared[RAW_CONSOLE][method](text) : console[method](text));

/** LOG_DIR is read from the process environment directly, so logging works even when the rest of the config is invalid. */
export function logFile(): string {
  return join(process.env.LOG_DIR || ".data/logs", "payrollhub.log");
}

let readyDir: string | undefined;

function append(entry: Record<string, unknown>): void {
  const file = logFile();
  const dir = join(file, "..");
  try {
    if (readyDir !== dir) {
      mkdirSync(dir, { recursive: true });
      readyDir = dir;
    }
    appendFileSync(file, `${JSON.stringify(entry)}\n`, { flag: "a", mode: 0o600 });
  } catch (err) {
    out("error", `[log] could not write to the log file: ${redactText((err as Error).message)}`);
  }
}

function write(level: Level, event: string, fields?: Record<string, unknown>): void {
  const entry = { time: new Date().toISOString(), level, event: redactText(event), ...(redact(fields ?? {}) as Record<string, unknown>) };
  append(entry);
  const rest = Object.fromEntries(Object.entries(entry).filter(([k]) => !["time", "level", "event"].includes(k)));
  out(level, `[${level}] ${entry.event}${Object.keys(rest).length ? ` ${JSON.stringify(rest)}` : ""}`);
}

/** The one logger. Fields are redacted before anything is written; pass errors as fields (e.g. { error: err }). */
export const log = {
  debug: (event: string, fields?: Record<string, unknown>) => write("debug", event, fields),
  info: (event: string, fields?: Record<string, unknown>) => write("info", event, fields),
  warn: (event: string, fields?: Record<string, unknown>) => write("warn", event, fields),
  error: (event: string, fields?: Record<string, unknown>) => write("error", event, fields),
};

/**
 * Routes console.* through redaction and into the log file. Run once at server startup (instrumentation.ts), so
 * output this codebase does not control, such as Next.js printing an unhandled error, is redacted too.
 */
export function installConsoleRedaction(): void {
  if (shared[RAW_CONSOLE]) return;
  const levels: Record<ConsoleMethod, Level> = { log: "info", info: "info", warn: "warn", error: "error", debug: "debug" };
  const captured = Object.fromEntries(METHODS.map((m) => [m, console[m].bind(console)])) as RawConsole;
  shared[RAW_CONSOLE] = captured;
  for (const method of METHODS) {
    console[method] = (...args: unknown[]) => {
      const text = redactText(formatWithOptions({ colors: false, depth: 6 }, ...args.map((a) => redact(a))));
      append({ time: new Date().toISOString(), level: levels[method], event: "console", message: text });
      captured[method](text);
    };
  }
}
