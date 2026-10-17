import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { ESLint } from "eslint";
import { describe, expect, it } from "vitest";

// L2-01: the approval token (and anything else sensitive) never reaches browser storage. The client keeps the token in
// React state only. Three checks: no source file uses a browser storage API, the approval component holds the token in
// state, and ESLint rejects storage APIs in app code. tests/threats/L2-01-approval-tokens.test.ts checks the response.

const ROOT = join(__dirname, "..", "..");
const STORAGE = /\b(localStorage|sessionStorage|indexedDB|cookieStore)\b|document\s*\.\s*cookie/;

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) walk(path, out);
    else if (/\.(ts|tsx|js|jsx)$/.test(name)) out.push(relative(ROOT, path).split(sep).join("/"));
  }
  return out;
}

describe("[L2-01 DiD] browser storage", () => {
  it("no client or server source under app/ or application/ uses a browser storage API", () => {
    const files = [...walk(join(ROOT, "app")), ...walk(join(ROOT, "application"))];
    expect(files).toContain("app/(console)/approver/approve-run.tsx");
    const offenders = files.filter((f) => STORAGE.test(readFileSync(join(ROOT, f), "utf8").replace(/\/\/.*$/gm, "")));
    expect(offenders).toEqual([]);
  });

  it("the approval component is a client component that keeps the token in React state", () => {
    const source = readFileSync(join(ROOT, "app/(console)/approver/approve-run.tsx"), "utf8");
    expect(source.startsWith('"use client"')).toBe(true);
    expect(source).toMatch(/useState<Approval \| null>/);
    expect(source).toMatch(/setApproval\(\{ token: body\.approvalToken/);
  });

  it("ESLint rejects browser storage in app code", async () => {
    const eslint = new ESLint({ cwd: ROOT });
    const code = [
      "export function leak(t: string) {",
      '  localStorage.setItem("t", t);',
      '  window.sessionStorage.setItem("t", t);',
      '  document.cookie = "t=" + t;',
      "  void indexedDB;",
      "}",
    ].join("\n");
    const [result] = await eslint.lintText(code, { filePath: "app/(console)/approver/example.tsx" });
    const storageErrors = result.messages.filter((m) => /browser storage/.test(m.message));
    expect(storageErrors).toHaveLength(4);
  }, 60_000);
});
