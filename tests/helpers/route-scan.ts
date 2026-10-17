import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

// Static check that every route handler under app/ is built by the one wrapper (application/http/route.ts).
// ESLint enforces the same rule while editing; this test also catches files where it was switched off.

const ROOT = join(__dirname, "..", "..");
const METHODS = "GET|HEAD|POST|PUT|PATCH|DELETE|OPTIONS";

export function scanRouteSource(source: string): string[] {
  const problems: string[] = [];
  for (const m of source.matchAll(new RegExp(`export\\s+(?:async\\s+)?function\\s+(${METHODS})\\b`, "g"))) {
    problems.push(`${m[1]} is a plain exported function`);
  }
  for (const m of source.matchAll(new RegExp(`export\\s+(?:const|let|var)\\s+(${METHODS})\\s*(?::[^=]+)?=\\s*([^\\n;]*)`, "g"))) {
    if (!/^route\.(session|service|public)\(/.test(m[2].trim())) problems.push(`${m[1]} is not built by route.session/service/public`);
  }
  if (/export\s*\{[^}]*\}/.test(source)) problems.push("re-exports a handler with export { ... }");
  if (/export\s+\*\s+from/.test(source)) problems.push("re-exports everything from another module");
  if (/export\s+default\b/.test(source)) problems.push("has a default export");
  if (/eslint-disable/.test(source)) problems.push("disables ESLint");
  if (!new RegExp(`export\\s+(?:const|let|var|(?:async\\s+)?function)\\s+(?:${METHODS})\\b`).test(source)) problems.push("exports no handler");
  if (!/import\s*{[^}]*\broute\b[^}]*}\s*from\s*["']@\/application\/http\/route["']/.test(source)) problems.push("does not import the route wrapper");
  return problems;
}

function walk(dir: string, out: string[]): string[] {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) walk(path, out);
    else if (/^route\.(ts|tsx|js|mjs)$/.test(name)) out.push(path);
  }
  return out;
}

/** Every route file under app/ with the problems found in it. */
export function scanRoutes(): { files: string[]; violations: { file: string; problem: string }[] } {
  const files = walk(join(ROOT, "app"), []).map((f) => relative(ROOT, f).split(sep).join("/"));
  const violations = files.flatMap((file) =>
    scanRouteSource(readFileSync(join(ROOT, file), "utf8")).map((problem) => ({ file, problem })),
  );
  return { files, violations };
}
