import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { errorResponse } from "@/application/http/route";
import { installConsoleRedaction, log, logFile, redact, redactText } from "@/data/log/logger";
import { onRequestError } from "@/instrumentation";
import { SEED_TENANTS } from "@/scripts/lib/seed";

// L2-12 (High): a generated ACH file in the logs exposes bank and routing numbers.
// Primary control: the central log pipeline (data/log/logger.ts) redacts at ingest, before anything is written:
// sensitive field names at any depth, and digit patterns (routing numbers, account-number-like runs, SSNs) in every
// string, including error messages and stack traces. Application code can only log through it (ESLint no-console,
// checked below), and the console itself is wrapped at startup, so Next.js's own error output is redacted too.

const ROUTING = "021000021";
const ACCOUNT = "730100000202";
const ALL_NUMBERS = [ROUTING, ACCOUNT, ...SEED_TENANTS.flatMap((t) => t.employees.flatMap((e) => [e.accountNumber, e.routingNumber]))];

const fileText = () => readFileSync(logFile(), "utf8");
const lines = () => fileText().trim().split("\n").map((l) => JSON.parse(l) as Record<string, unknown>);
const lastLine = () => lines().at(-1)!;

function expectClean(text: string) {
  for (const n of ALL_NUMBERS) expect(text, `found ...${n.slice(-4)}`).not.toContain(n);
}

const mirrored: string[] = [];
beforeAll(() => {
  // What the logger mirrors to the console is captured too, and must be just as clean.
  for (const method of ["log", "info", "warn", "error", "debug"] as const) {
    vi.spyOn(console, method).mockImplementation((...args: unknown[]) => void mirrored.push(args.map(String).join(" ")));
  }
});
afterAll(() => vi.restoreAllMocks());

describe("[L2-12] redaction by pattern, in every string", () => {
  it("redacts a routing and account number inside an error message", () => {
    log.error("ach.send_failed", { error: new Error(`bank refused entry for routing ${ROUTING} account ${ACCOUNT}`) });
    const entry = lastLine() as { error: { message: string; stack: string } };
    expect(entry.error.message).toBe("bank refused entry for routing [ROUTING] account [REDACTED]");
    expect(entry.error.stack).toContain("[ROUTING]");
  });

  it("redacts them inside a nested object, by field name and by pattern", () => {
    log.info("payment.debug", {
      tenantId: "acme",
      payment: { employee: { name: "Bob", accountNumber: ACCOUNT, routing_number: ROUTING, note: `paid to ${ACCOUNT.replace(/(\d{4})/g, "$1 ").trim()} via ${ROUTING}` } },
      list: [{ deep: { deeper: { text: `acct=${ACCOUNT}` } } }],
      amountCents: 224_250,
    });
    const entry = lastLine() as { payment: { employee: Record<string, string> }; list: { deep: { deeper: { text: string } } }[]; amountCents: number; tenantId: string };
    expect(entry.payment.employee).toEqual({ name: "Bob", accountNumber: "[REDACTED]", routing_number: "[REDACTED]", note: "paid to [REDACTED] via [ROUTING]" });
    expect(entry.list[0].deep.deeper.text).toBe("acct=[REDACTED]");
    expect(entry.amountCents).toBe(224_250); // ordinary numbers survive
    expect(entry.tenantId).toBe("acme");
  });

  it("redacts them inside a stack trace and an error's cause chain", () => {
    const err = new Error("could not sign batch");
    err.stack = `Error: could not sign batch\n    at buildEntry (file:///srv/ach/${ACCOUNT}.ts:12:7)\n    at entry 622${ROUTING}${ACCOUNT}     0000224250`;
    (err as Error & { cause: unknown }).cause = new Error(`file line: 6220210000217301000002020000224250`);
    log.error("ach.build_failed", { error: err });
    const raw = JSON.stringify(lastLine());
    expectClean(raw);
    expect(raw).toContain("[REDACTED]");
  });

  it("redacts SSNs and a whole NACHA entry record in free text", () => {
    const entry = `6220110000157301000001010000243750E1             ALICE ANDERS            0011000020000001`;
    expect(redactText(`SSN 123-45-6789, alt 123 45 6789`)).toBe("SSN [SSN], alt [SSN]");
    const out = redactText(`bad record: ${entry}`);
    expectClean(out);
    expect(out).toContain("ALICE ANDERS"); // names are not digit patterns; the file body itself is never logged
  });

  it("keeps what is not sensitive: UUIDs, dates, times, small numbers", () => {
    const text = "run 0c1e2a33-4b5c-4d6e-8f70-123456789012 on 2026-10-16 at 21:24:17, status 409, port 3000, 3 entries";
    expect(redactText(text)).toBe(text);
  });

  it("replaces every field in the shared logging schema, whatever its case or separators", () => {
    const out = redact({ password: "pw", Token: "t", approval_token: "a", fileBody: "622...", "set-cookie": "c", Authorization: "Bearer x", secret: { nested: 1 } });
    expect(Object.values(out as object).every((v) => v === "[REDACTED]")).toBe(true);
  });
});

describe("[L2-12] every path into the logs goes through redaction", () => {
  it("the route wrapper's unhandled-error path logs redacted details and returns a generic 500", async () => {
    const res = errorResponse(new Error(`update failed for account ${ACCOUNT}`), "req-123");
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: "Internal error", requestId: "req-123" });
    const entry = lastLine() as { event: string; requestId: string; error: { message: string } };
    expect(entry).toMatchObject({ event: "api.unhandled_error", requestId: "req-123" });
    expect(entry.error.message).toBe("update failed for account [REDACTED]");
  });

  it("Next.js's onRequestError hook logs redacted errors, without headers or the query string", async () => {
    process.env.NEXT_RUNTIME = "nodejs";
    try {
      await onRequestError(
        new Error(`render failed with ${ROUTING}`),
        { path: "/employee/bank-change/abc?token=secret-link-token", method: "GET", headers: { cookie: "__Host-ph_session=abc", authorization: "Bearer x" } },
        { routerKind: "App Router", routePath: "/employee/bank-change/[changeId]", routeType: "render", renderSource: "react-server-components", revalidateReason: undefined },
      );
    } finally {
      delete process.env.NEXT_RUNTIME;
    }
    const raw = JSON.stringify(lastLine());
    expect(lastLine()).toMatchObject({ event: "request.unhandled_error", method: "GET", path: "/employee/bank-change/abc" });
    expect(raw).not.toMatch(/secret-link-token|__Host-ph_session|Bearer x/);
    expectClean(raw);
  });

  it("the console wrapper redacts output it did not produce (Next.js, dependencies) and records it", () => {
    const captured: string[] = [];
    vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => void captured.push(args.map(String).join(" ")));
    installConsoleRedaction();
    console.error("Unhandled:", new Error(`charge ${ACCOUNT} via ${ROUTING}`), { accountNumber: ACCOUNT });
    expect(captured).toHaveLength(1);
    expectClean(captured[0]);
    expect(captured[0]).toContain("[REDACTED]");
    expect(lastLine()).toMatchObject({ event: "console", level: "error" });
    expectClean(JSON.stringify(lastLine()));
  });

  it("each event is written once, even from a second copy of the logger module (Next.js bundles one per entry point)", async () => {
    vi.resetModules();
    const copy = await import("@/data/log/logger");
    const before = lines().length;
    copy.log.info("copy.check", { n: 2 });
    expect(lines().length).toBe(before + 1);
    expect(lastLine()).toMatchObject({ event: "copy.check", n: 2 });
  });

  it("the log file is structured JSON lines and only ever grows (append-only)", () => {
    const before = fileText();
    log.info("append.check", { n: 1 });
    const after = fileText();
    expect(after.startsWith(before)).toBe(true);
    for (const l of lines()) expect(l).toMatchObject({ time: expect.any(String), level: expect.stringMatching(/^(debug|info|warn|error)$/), event: expect.any(String) });
  });

  it("no full account or routing number anywhere in the log file or the console output", () => {
    expectClean(fileText());
    expectClean(mirrored.join("\n"));
  });

  it("no application code calls console.* directly (ESLint no-console, also checked here)", () => {
    const root = join(__dirname, "..", "..");
    const skip = new Set(["node_modules", ".next", ".git", ".data", "tests", "scripts", "public", "migrations"]);
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const path = join(dir, name);
        if (statSync(path).isDirectory()) {
          if (!skip.has(name)) walk(path);
        } else if (/\.(ts|tsx|mjs|js)$/.test(name) && !/\.config\./.test(name)) {
          const rel = relative(root, path).split(sep).join("/");
          if (rel === "data/log/logger.ts") continue;
          if (/\bconsole\.(log|info|warn|error|debug)\s*\(/.test(readFileSync(path, "utf8"))) offenders.push(rel);
        }
      }
    };
    walk(root);
    expect(offenders).toEqual([]);
  });
});
