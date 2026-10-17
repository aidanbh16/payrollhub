import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

// Builds the submission folder the way the ZIP will hold it (author's tool; needs git):
//   npm run submission -- <empty target folder>
// It copies every file git would include (tracked files, plus new files that .gitignore does not exclude), so
// node_modules, .env, .data/ (database, keys, certificates, logs, credentials), .next, and .git never go in. Then it
// checks the result against that list again and exits 1 if anything forbidden is there.

const ROOT = join(import.meta.dirname, "..");
const target = process.argv[2] && resolve(process.argv[2]);
if (!target) {
  console.error("Usage: npm run submission -- <empty target folder>");
  process.exit(1);
}
if (existsSync(target) && readdirSync(target).length > 0) {
  console.error(`${target} is not empty; choose a new or empty folder.`);
  process.exit(1);
}

const files = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "-z"], { cwd: ROOT, encoding: "utf8" })
  .split("\0")
  .filter((f) => f && existsSync(join(ROOT, f))); // a tracked file deleted in the working tree is left out
for (const file of files) {
  mkdirSync(dirname(join(target, file)), { recursive: true });
  copyFileSync(join(ROOT, file), join(target, file));
}

// What must never be in the ZIP: dependencies, build output, git history, local configuration and secrets, runtime
// data (database, keys, certificates, logs, the credentials file), and test output.
const FORBIDDEN: [RegExp, string][] = [
  [/(^|\/)node_modules(\/|$)/, "dependencies"],
  [/(^|\/)\.next(\/|$)/, "build output"],
  [/(^|\/)\.git(\/|$)/, "git history"],
  [/(^|\/)\.env(\.(?!example$)[^/]*)?$/, "local configuration"],
  [/(^|\/)\.data(\/|$)/, "runtime data"],
  [/\.(db|db-journal|db-wal|db-shm|sqlite3?)$/, "database"],
  [/\.(log|jsonl)$/, "logs"],
  [/\.(pem|key|crt|p12|pfx)$/, "keys or certificates"],
  [/credentials/i, "credentials"],
  [/(^|\/)(test-results|playwright-report|coverage)(\/|$)/, "test output"],
  [/\.tsbuildinfo$/, "build cache"],
];
function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    out.push(relative(target!, full).replaceAll("\\", "/"));
    if (statSync(full).isDirectory()) walk(full, out);
  }
  return out;
}
const copied = walk(target);
const bad = copied.flatMap((p) => FORBIDDEN.filter(([re]) => re.test(p)).map(([, why]) => `${p} (${why})`));
// scripts/lib/dev-credentials.ts is the code that writes the credentials file, not a credentials file.
const real = bad.filter((b) => !b.startsWith("scripts/lib/dev-credentials.ts "));
if (real.length) {
  console.error(`Refusing: the submission folder contains:\n${real.map((b) => `  ${b}`).join("\n")}`);
  process.exit(1);
}
console.log(`Copied ${files.length} files to ${target}. None of them is a dependency, build output, git data, .env, runtime data, database, log, key, certificate, or credentials file.`);
