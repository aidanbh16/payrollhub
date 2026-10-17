import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";

// Checks that every file path the README and the docs/ pages mention exists in the project, and that every Markdown
// link (and its #anchor) resolves:
//   npm run docs:check
// A path in `code` is read from the project root (that is how the docs write them); a Markdown link is read from the
// page that holds it. Paths under .data/, .env, and .next are created by the setup scripts or the build, so they are
// listed but not required. Exits 1 if anything is missing.

const ROOT = join(import.meta.dirname, "..");
const PAGES = ["README.md", ...readdirSync(join(ROOT, "docs")).filter((f) => f.endsWith(".md")).map((f) => `docs/${f}`)];
const RUNTIME = /^(\.data\/|\.env$|\.next\/)/;
const EXTENSIONS = /\.(ts|tsx|mts|mjs|cjs|js|json|md|sql|ya?ml|txt|pem|css|db|log|jsonl)$/;
// Reviewer scripts quoted in docs/red-team.md: they lived in the reviewers' own working folders, outside the project.
const EXTERNAL = /^(scratchpad\/|\.\.\.\/redteam2\/|r\d-[\w-]+\.mjs$|rt0\d-[\w-]+\.mjs$|authlib\.mjs$|attack2?\.mjs$|lan-employee\.mjs$|dos-[\w-]+\.mjs$|login-ceiling\.mjs$|lockout\.mjs$|redis-test\.mjs$)/;

const SKIP_DIRS = new Set(["node_modules", ".next", ".git", ".data", "test-results", "playwright-report"]);
function allFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) allFiles(full, out);
    else out.push(relative(ROOT, full).replaceAll("\\", "/"));
  }
  return out;
}
const FILES = allFiles(ROOT);
const TOP_LEVEL = new Set(readdirSync(ROOT));

/** GitHub's heading anchors: lowercase, punctuation dropped (except - and _), spaces to hyphens. */
const slug = (heading: string) =>
  heading.trim().toLowerCase().replace(/`/g, "").replace(/[^\p{L}\p{N}\s_-]/gu, "").replace(/\s/g, "-");
const anchors = (page: string) =>
  new Set(readFileSync(join(ROOT, page), "utf8").split("\n").filter((l) => /^#{1,6} /.test(l)).map((l) => slug(l.replace(/^#+ /, ""))));

/** Does a root-relative path (possibly a directory, possibly with * or ** globs) exist? */
function exists(path: string): boolean {
  const clean = path.replace(/\/$/, "");
  if (!clean.includes("*")) return existsSync(join(ROOT, clean));
  const pattern = new RegExp(`^${clean.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*\*/g, "\u0000").replace(/\*/g, "[^/]+").replace(/\u0000/g, ".*")}(/|$)`);
  return FILES.some((f) => pattern.test(f));
}

const problems: string[] = [];
const runtime = new Set<string>();
let checked = 0;

for (const page of PAGES) {
  const text = readFileSync(join(ROOT, page), "utf8");
  const lines = text.split("\n");
  lines.forEach((line, i) => {
    const where = `${page}:${i + 1}`;
    // Markdown links: [text](target). External URLs and pure #anchors on the same page are handled separately.
    for (const [, target] of line.matchAll(/\]\(([^)\s]+)\)/g)) {
      if (/^[a-z]+:/i.test(target)) continue;
      const [file, anchor] = target.split("#");
      const resolved = file ? relative(ROOT, join(ROOT, dirname(page), file)).replaceAll("\\", "/") : page;
      checked++;
      if (!exists(resolved)) problems.push(`${where}: link target ${target} (${resolved}) does not exist`);
      else if (anchor && resolved.endsWith(".md") && !anchors(resolved).has(anchor)) problems.push(`${where}: no heading for #${anchor} in ${resolved}`);
    }
    // Paths in `code`: anything that looks like a file or folder of this project.
    for (const [, span] of line.matchAll(/`([^`\s]+)`/g)) {
      const path = span.replace(/:\d[\d,-]*$/, ""); // file:line references
      if (/^(\/|<|-|@)/.test(path) || /[<>=$]|:\/\/|^\d/.test(path)) continue; // routes, URLs, placeholders, flags, addresses
      // A path has a file extension, or names a top-level file or folder of the project (so prose such as
      // `run/all/get/values` is not mistaken for one).
      if (!EXTENSIONS.test(path) && path !== ".env.example" && !(path.includes("/") && TOP_LEVEL.has(path.split("/")[0]))) continue;
      if (EXTERNAL.test(path)) continue;
      if (RUNTIME.test(path)) {
        runtime.add(path);
        continue;
      }
      checked++;
      const found = path.includes("/") ? exists(path) : exists(path) || FILES.some((f) => f.endsWith(`/${path}`));
      if (!found) problems.push(`${where}: ${span} does not exist`);
    }
  });
}

console.log(`Checked ${checked} paths and links in ${PAGES.length} pages (${PAGES.join(", ")}).`);
console.log(`Created at runtime, not required in the source tree: ${[...runtime].sort().join(", ")}`);
if (problems.length) {
  console.error(`\n${problems.length} missing:\n${problems.map((p) => `  ${p}`).join("\n")}`);
  process.exit(1);
}
console.log("Every path and link exists.");
