import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

// Static check that application code cannot reach the base tables. ESLint enforces the same rules while editing;
// this test also catches files where those rules were switched off with an eslint-disable comment.

const ROOT = join(__dirname, "..", "..");
const SKIP_DIRS = new Set(["node_modules", ".next", ".git", ".data", "data", "migrations", "tests", "public"]);
const SOURCE = /\.(ts|tsx|mts|js|mjs)$/;

const BASE_TABLES = [
  "tenant", "app_user", "session", "tenant_idp_config", "service_grant", "employee", "payroll_run",
  "approval_token", "pay_result", "bank_account", "bank_account_change", "verification_code", "ach_batch",
];

// Modules that expose the raw handle or the base tables. Only data/db/ may import them (plus migrate for scripts/).
const FORBIDDEN_MODULE = /from\s+["'](better-sqlite3|drizzle-orm\/better-sqlite3(\/.*)?|(?:@\/|(?:\.\.?\/)+)?(?:.*\/)?data\/db\/(tables|connection|scope-state|scope-runner|migrate))["']/g;
const RAW_SELECT = new RegExp(`select[\\s\\S]{0,200}?\\b(?:from|join)\\s+[\`"']?(${BASE_TABLES.join("|")})\\b`, "gi");
const DISABLED_RULE = /eslint-disable[^\n]*no-restricted-(imports|syntax|properties)/g;

export interface Violation {
  file: string;
  problem: string;
}

export function scanSource(file: string, source: string): Violation[] {
  const violations: Violation[] = [];
  for (const m of source.matchAll(FORBIDDEN_MODULE)) {
    const isScriptMigrate = file.startsWith("scripts/") && m[3] === "migrate";
    if (!isScriptMigrate) violations.push({ file, problem: `imports ${m[1]}` });
  }
  for (const m of source.matchAll(RAW_SELECT)) violations.push({ file, problem: `raw SQL reads base table ${m[1]}` });
  for (const m of source.matchAll(DISABLED_RULE)) violations.push({ file, problem: `disables ${m[0].trim()}` });
  return violations;
}

// D23: the Drizzle sql tag is allowed in exactly one place: as a check(...) constraint expression in data/db/tables.ts.
const SQL_TAG = /\bsql`/g;
const CHECK_SQL_TAG = /\bcheck\(\s*"[^"]+",\s*sql`/g;
const SQL_IMPORT = /import\s*(?:type\s*)?{[^}]*\bsql\b[^}]*}\s*from\s*["']drizzle-orm(?:\/sql)?["']/g;
const SQL_MEMBER = /\bsql\.\w+/g;
const count = (re: RegExp, source: string) => [...source.matchAll(re)].length;

export function scanSqlTag(file: string, source: string): Violation[] {
  const violations: Violation[] = [];
  if (file === "data/db/tables.ts") {
    const outsideCheck = count(SQL_TAG, source) - count(CHECK_SQL_TAG, source);
    if (outsideCheck > 0) violations.push({ file, problem: `uses the sql tag outside check() ${outsideCheck} time(s)` });
  } else {
    if (count(SQL_TAG, source) > 0) violations.push({ file, problem: "uses the sql tag" });
    if (count(SQL_IMPORT, source) > 0) violations.push({ file, problem: "imports sql from drizzle-orm" });
  }
  if (count(SQL_MEMBER, source) > 0) violations.push({ file, problem: "uses sql.raw or another sql helper" });
  return violations;
}

/** Scans every source file, including data/, for sql tag use beyond the D23 exception. */
export function scanSqlTagUsage(): { files: string[]; violations: Violation[] } {
  // eslint.config.mjs defines the lint rules, so it names sql helpers in its messages; it runs no queries.
  const files = walk(ROOT, [], SKIP_DIRS_SQL)
    .map((f) => relative(ROOT, f).split(sep).join("/"))
    .filter((f) => f !== "eslint.config.mjs");
  const violations = files.flatMap((f) => scanSqlTag(f, readFileSync(join(ROOT, f), "utf8")));
  return { files, violations };
}

const SKIP_DIRS_SQL = new Set([...SKIP_DIRS].filter((d) => d !== "data"));

function walk(dir: string, out: string[], skip: ReadonlySet<string> = SKIP_DIRS): string[] {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) {
      if (!skip.has(name)) walk(path, out, skip);
    } else if (SOURCE.test(name)) {
      out.push(path);
    }
  }
  return out;
}

/** Scans every application source file outside data/, migrations/, and tests/. */
export function scanApplicationSource(): { files: string[]; violations: Violation[] } {
  const files = walk(ROOT, []).map((f) => relative(ROOT, f).split(sep).join("/"));
  const violations = files.flatMap((f) => scanSource(f, readFileSync(join(ROOT, f), "utf8")));
  return { files, violations };
}
