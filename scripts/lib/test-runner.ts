import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { THREATS } from "@/tests/threat-registry";

// Runs vitest and Playwright from the scripts (npm test, npm run test:e2e, npm run traceability), translating threat
// IDs into title filters. Tags are described in tests/threat-registry.ts.

export const ROOT = join(__dirname, "..", "..");
const THREAT_ID = /^L\d-\d{2}$/i;
const BIN = {
  vitest: join(ROOT, "node_modules", "vitest", "vitest.mjs"),
  playwright: join(ROOT, "node_modules", "@playwright", "test", "cli.js"),
  next: join(ROOT, "node_modules", "next", "dist", "bin", "next"),
};

/** Splits command-line arguments into threat IDs and everything else; an ID that is not in the registry is an error. */
export function splitThreatArgs(args: string[]): { ids: string[]; rest: string[] } {
  const ids = args.filter((a) => THREAT_ID.test(a)).map((a) => a.toUpperCase());
  const unknown = ids.filter((id) => !THREATS.some((t) => t.id === id));
  if (unknown.length > 0) {
    throw new Error(`Not one of the 15 Assignment 4 threats: ${unknown.join(", ")}. Known: ${THREATS.map((t) => t.id).join(" ")}`);
  }
  return { ids, rest: args.filter((a) => !THREAT_ID.test(a)) };
}

/** Matches a test whose full title carries [ID] or [ID DiD] for any of the IDs. */
export const tagPattern = (ids: string[]) => `\\[(${ids.join("|")})( DiD)?\\]`;

function files(dir: string, test: RegExp, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) files(path, test, out);
    else if (test.test(name)) out.push(relative(ROOT, path).split(sep).join("/"));
  }
  return out;
}

/** Test files that mention one of the tags, so a single-threat run loads only those files. */
function filesWithTags(dir: string, test: RegExp, ids: string[]): string[] {
  const tag = new RegExp(tagPattern(ids));
  return files(join(ROOT, dir), test).filter((f) => tag.test(readFileSync(join(ROOT, f), "utf8")));
}

function run(bin: string, args: string[], env: NodeJS.ProcessEnv = process.env): number {
  return spawnSync(process.execPath, [bin, ...args], { cwd: ROOT, stdio: "inherit", env }).status ?? 1;
}

export function runVitest(ids: string[], rest: string[]): number {
  if (ids.length === 0) return run(BIN.vitest, ["run", ...rest]);
  const selected = filesWithTags("tests", /\.test\.ts$/, ids);
  console.log(`Threat ${ids.join(", ")}: ${selected.length} test file(s), filtered to tests tagged ${ids.map((id) => `[${id}] or [${id} DiD]`).join(", ")}`);
  if (selected.length === 0) return 1;
  return run(BIN.vitest, ["run", ...selected, "-t", tagPattern(ids), ...rest]);
}

export function runPlaywright(ids: string[], rest: string[], env?: NodeJS.ProcessEnv, build = true): number {
  if (build) {
    const status = run(BIN.next, ["build"]);
    if (status !== 0) return status;
  }
  return run(BIN.playwright, ["test", ...(ids.length > 0 ? ["--grep", tagPattern(ids)] : []), ...rest], env);
}

/** Lists tests without running them. Vitest collects the files (describe bodies run; tests and hooks do not). */
export function listVitest(outFile: string): { name: string; file: string }[] {
  const res = spawnSync(process.execPath, [BIN.vitest, "list", `--json=${outFile}`], { cwd: ROOT, encoding: "utf8" });
  if (res.status !== 0) throw new Error(`vitest list failed:\n${res.stdout}\n${res.stderr}`);
  const entries = JSON.parse(readFileSync(outFile, "utf8")) as { name: string; file: string }[];
  return entries.map((e) => ({ name: e.name, file: relative(ROOT, e.file).split(sep).join("/") }));
}

interface PwSuite {
  title: string;
  file?: string;
  specs?: { title: string; file: string; ok?: boolean }[];
  suites?: PwSuite[];
}

/** Walks Playwright's JSON report (from --list or a real run): one entry per spec, with its describe titles. */
export function playwrightSpecs(report: { suites: PwSuite[] }): { name: string; file: string; ok?: boolean }[] {
  const out: { name: string; file: string; ok?: boolean }[] = [];
  const walk = (suite: PwSuite, titles: string[]) => {
    for (const spec of suite.specs ?? []) out.push({ name: [...titles, spec.title].join(" > "), file: `e2e/${spec.file}`, ok: spec.ok });
    for (const child of suite.suites ?? []) walk(child, [...titles, child.title]);
  };
  // The top-level suites are files; their title is the file name, not a describe.
  for (const file of report.suites) walk(file, []);
  return out;
}

export function listPlaywright(): { name: string; file: string }[] {
  const res = spawnSync(process.execPath, [BIN.playwright, "test", "--list", "--reporter=json"], { cwd: ROOT, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  if (res.status !== 0) throw new Error(`playwright --list failed:\n${res.stderr}`);
  return playwrightSpecs(JSON.parse(res.stdout));
}

export const vitestBin = BIN.vitest;
