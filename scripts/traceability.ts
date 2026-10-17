import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { THREATS, type Threat } from "@/tests/threat-registry";
import { ROOT, listPlaywright, listVitest, playwrightSpecs, runPlaywright, vitestBin } from "./lib/test-runner";

// Threat-to-test traceability (Layer 10). Reads the threat tags from every vitest and Playwright test (as the runners
// collect them, so describe nesting and generated tests count correctly) and fails when:
//   - any of the 15 Assignment 4 threats has no test, no test of its primary control, or (when it has
//     defense-in-depth controls) no test of those;
//   - any test names a threat ID that is not in the Assignment 4 list, or a tag is malformed;
//   - a control file named in tests/threat-registry.ts does not exist.
//
//   npm run traceability                   check, and print the summary
//   npm run traceability -- --markdown     also print the README table
//   npm run traceability -- --write-readme also replace the table in README.md
//   npm run traceability -- --run [--e2e]  run the suites and report results grouped by threat ID

interface TestCase {
  runner: "vitest" | "e2e";
  file: string;
  name: string;
  tags: { id: string; did: boolean }[];
  ok?: boolean;
}

const flags = new Set(process.argv.slice(2));
const errors: string[] = [];
const known = new Set(THREATS.map((t) => t.id));
const ANY_ID = /\bL\d-\d{2}\b/g;

function tagsOf(file: string, name: string): TestCase["tags"] {
  const tags: TestCase["tags"] = [];
  for (const [, body] of name.matchAll(/\[([^\]]*)\]/g)) {
    if (!/L\d-\d{2}/.test(body)) continue;
    const m = /^(L\d-\d{2})( DiD)?$/.exec(body);
    if (!m) errors.push(`${file}: malformed tag [${body}] (expected [Lx-yy] or [Lx-yy DiD]) in "${name}"`);
    else if (!known.has(m[1])) errors.push(`${file}: [${body}] is not one of the 15 Assignment 4 threats ("${name}")`);
    else if (!tags.some((t) => t.id === m[1] && t.did === Boolean(m[2]))) tags.push({ id: m[1], did: Boolean(m[2]) });
  }
  // A threat ID mentioned outside a tag must still be a real one.
  for (const [id] of name.replace(/\[[^\]]*\]/g, "").matchAll(ANY_ID)) {
    if (!known.has(id)) errors.push(`${file}: mentions ${id}, which is not one of the 15 Assignment 4 threats ("${name}")`);
  }
  return tags;
}

const scratch = join(tmpdir(), `payrollhub-traceability-${process.pid}`);
mkdirSync(scratch, { recursive: true });

function collect(withResults: boolean): TestCase[] {
  let vitest: { name: string; file: string; ok?: boolean }[];
  let e2e: { name: string; file: string; ok?: boolean }[];
  if (withResults) {
    const out = join(scratch, "vitest.json");
    spawnSync(process.execPath, [vitestBin, "run", "--reporter=default", "--reporter=json", `--outputFile.json=${out}`], { cwd: ROOT, stdio: "inherit" });
    const report = JSON.parse(readFileSync(out, "utf8")) as { testResults: { name: string; assertionResults: { ancestorTitles: string[]; title: string; status: string }[] }[] };
    vitest = report.testResults.flatMap((f) =>
      f.assertionResults.map((a) => ({ name: [...a.ancestorTitles, a.title].join(" > "), file: f.name.slice(ROOT.length + 1).replace(/\\/g, "/"), ok: a.status === "passed" })),
    );
    if (flags.has("--e2e")) {
      const pwOut = join(scratch, "playwright.json");
      runPlaywright([], ["--reporter=list,json"], { ...process.env, PLAYWRIGHT_JSON_OUTPUT_FILE: pwOut });
      e2e = playwrightSpecs(JSON.parse(readFileSync(pwOut, "utf8")));
    } else e2e = listPlaywright();
  } else {
    vitest = listVitest(join(scratch, "vitest-list.json"));
    e2e = listPlaywright();
  }
  return [
    ...vitest.map((t) => ({ runner: "vitest" as const, ...t, tags: tagsOf(t.file, t.name) })),
    ...e2e.map((t) => ({ runner: "e2e" as const, ...t, ok: withResults && flags.has("--e2e") ? t.ok : undefined, tags: tagsOf(t.file, t.name) })),
  ];
}

const tests = collect(flags.has("--run"));

for (const t of THREATS) {
  for (const path of [...t.primary, ...t.defenseInDepth]) {
    if (!existsSync(join(ROOT, path))) errors.push(`${t.id}: control file ${path} (tests/threat-registry.ts) does not exist`);
  }
}

const testsFor = (t: Threat) => tests.filter((c) => c.tags.some((g) => g.id === t.id));
const primaryFor = (t: Threat) => tests.filter((c) => c.tags.some((g) => g.id === t.id && !g.did));
const didFor = (t: Threat) => tests.filter((c) => c.tags.some((g) => g.id === t.id && g.did));
const unique = <T,>(xs: T[]) => [...new Set(xs)];

for (const t of THREATS) {
  if (testsFor(t).length === 0) errors.push(`${t.id} (${t.threat}) has no tagged test`);
  else if (primaryFor(t).length === 0) errors.push(`${t.id} has no test tagged [${t.id}] attacking its primary control`);
  if (t.defenseInDepth.length > 0 && didFor(t).length === 0) errors.push(`${t.id} has defense-in-depth controls but no test tagged [${t.id} DiD]`);
}

// ---------- report ----------

const pad = (s: string | number, n: number) => String(s).padEnd(n);
console.log(`\nThreat-to-test traceability: ${tests.length} tests (${tests.filter((c) => c.runner === "vitest").length} vitest, ${tests.filter((c) => c.runner === "e2e").length} browser)\n`);
console.log(`${pad("Threat", 7)} ${pad("Tests", 6)} ${pad("Primary", 8)} ${pad("DiD", 5)} ${pad("Browser", 8)} ${flags.has("--run") ? "Result  " : ""}Threat`);
for (const t of THREATS) {
  const all = testsFor(t);
  const result = flags.has("--run")
    ? (() => {
        const ran = all.filter((c) => c.ok !== undefined);
        const failed = ran.filter((c) => !c.ok).length;
        return pad(failed === 0 ? `${ran.length} ok` : `${failed} FAIL`, 8);
      })()
    : "";
  console.log(`${pad(t.id, 7)} ${pad(all.length, 6)} ${pad(primaryFor(t).length, 8)} ${pad(didFor(t).length, 5)} ${pad(all.filter((c) => c.runner === "e2e").length, 8)} ${result}${t.threat}`);
}

const untagged = tests.filter((c) => c.tags.length === 0);
console.log(`\nNot tagged to any of the 15 threats (${untagged.length}; general correctness and tooling tests):`);
for (const c of untagged) console.log(`  ${c.file} > ${c.name}`);

if (flags.has("--run")) {
  const failed = tests.filter((c) => c.ok === false);
  console.log(`\nResults grouped by threat ID:`);
  for (const t of THREATS) {
    console.log(`\n${t.id}  ${t.threat}`);
    for (const c of testsFor(t)) {
      const kind = c.tags.filter((g) => g.id === t.id).map((g) => (g.did ? "DiD" : "primary")).join("+");
      const status = c.ok === undefined ? "not run" : c.ok ? "pass" : "FAIL";
      console.log(`  ${pad(status, 7)} ${pad(kind, 8)} ${c.file} > ${c.name}`);
    }
  }
  if (failed.length > 0) errors.push(`${failed.length} test(s) failed: ${failed.map((c) => c.name).join("; ")}`);
}

function markdownTable(): string {
  const code = (paths: string[]) => (paths.length === 0 ? "none" : paths.map((p) => `\`${p}\``).join(", "));
  const rows = THREATS.map((t) => {
    const all = testsFor(t);
    const count = `${all.length} (${primaryFor(t).length} primary, ${didFor(t).length} DiD)`;
    return `| ${t.id} | ${t.threat} | ${code(t.primary)} | ${code(t.defenseInDepth)} | ${code(unique(all.map((c) => c.file)).sort())} | ${count} |`;
  });
  return [
    "| Threat ID | Threat | Primary control file(s) | Defense-in-depth control file(s) | Test file(s) | Tests |",
    "|---|---|---|---|---|---|",
    ...rows,
  ].join("\n");
}

if (flags.has("--markdown")) console.log(`\n${markdownTable()}`);
if (flags.has("--write-readme")) {
  const readme = join(ROOT, "README.md");
  const text = readFileSync(readme, "utf8");
  const start = "<!-- traceability:start (generated by npm run traceability -- --write-readme; do not edit) -->";
  const end = "<!-- traceability:end -->";
  const i = text.indexOf(start);
  const j = text.indexOf(end);
  if (i < 0 || j < i) errors.push("README.md has no traceability markers");
  else {
    writeFileSync(readme, `${text.slice(0, i + start.length)}\n${markdownTable()}\n${text.slice(j)}`);
    console.log("\nREADME.md traceability table updated.");
  }
}

if (errors.length > 0) {
  console.error(`\nTRACEABILITY FAILED (${errors.length}):`);
  for (const e of errors) console.error(`  - ${e}`);
  process.exit(1);
}
console.log(`\nTraceability passed: all ${THREATS.length} threats have a primary-control test${THREATS.some((t) => t.defenseInDepth.length > 0) ? ", and every threat with defense-in-depth controls has a test of them" : ""}; every tag names an Assignment 4 threat.`);
