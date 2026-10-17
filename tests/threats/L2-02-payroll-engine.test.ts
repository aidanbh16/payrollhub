import { generateKeyPairSync, randomUUID } from "node:crypto";
import { SignJWT, base64url, decodeJwt, decodeProtectedHeader } from "jose";
import { NextRequest } from "next/server";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { POST as engineStartPOST } from "@/app/api/internal/engine/tenants/[tenantId]/runs/[runId]/start/route";
import { POST as approvePOST } from "@/app/api/tenants/[tenantId]/runs/[runId]/approve/route";
import { POST as startPOST } from "@/app/api/tenants/[tenantId]/runs/[runId]/start/route";
import { mintAsBff } from "@/application/mint-as-bff";
import { withTenant } from "@/data/db/tenant-scope";
import { rotateSigningKey } from "@/data/keys/kms";
import { SEED_TENANTS, seededPassword, seededTotpSecret } from "@/scripts/lib/seed";
import { insertVerifiedAccount } from "@/services/bank-account/repository";
import { startRun } from "@/services/engine/engine-service";
import { computePay } from "@/services/engine/pay-calc";
import { insertEmployee, insertPayrollRun } from "@/services/engine/repository";
import { canonicalRunContent, runContentHash, type RunContent } from "@/services/engine/run-content";
import { ApprovalRejectedError, ConflictError, RunFailedError } from "@/services/errors";
import { insertUser, listUsers } from "@/services/identity/repository";
import { idsFor, rawSqlite, setupSeededDatabase } from "../helpers/database";
import { Browser, advance, staffLogin, totpNow, useFakeClock } from "../helpers/http";

// L2-02 (High): an unverified approval-token signature authorizes a run as any admin.
// Primary control: Payroll Engine (services/engine/engine-service.ts) verifies the approval token's signature against
// the key-store key for its kid, algorithm pinned, before computing anything; then tenant, run, approver, separation of
// duties (D27), and the run-content hash (D28); then Payroll Approval redeems it atomically, in the same transaction
// that writes every pay result.

setupSeededDatabase();

const [acme, globex] = SEED_TENANTS;
let approver: Browser;
let globexApprover: Browser;

const db = () => rawSqlite();
const count = (table: string, runId: string) => (db().prepare(`SELECT count(*) AS n FROM ${table} WHERE run_id = ?`).get(runId) as { n: number }).n;
const runRow = (runId: string) =>
  db().prepare("SELECT status, failure_reason, approved_by FROM payroll_run WHERE run_id = ?").get(runId) as {
    status: string;
    failure_reason: string | null;
    approved_by: string | null;
  };
const tokenRedeemed = (runId: string) =>
  (db().prepare("SELECT count(*) AS n FROM approval_token WHERE run_id = ? AND redeemed_at IS NOT NULL").get(runId) as { n: number }).n;

function newDraftRun(tenantId = "acme", createdBy = idsFor(tenantId).hrAdminId): string {
  const runId = randomUUID();
  withTenant(tenantId, (s) => insertPayrollRun(s, { runId, payDate: "2026-11-27", status: "draft", createdBy, approvedBy: null }));
  return runId;
}

async function approve(runId: string, tenantId = "acme") {
  advance(31);
  const [browser, secret] = tenantId === "acme" ? [approver, seededTotpSecret(acme.approver.email)] : [globexApprover, seededTotpSecret(globex.approver.email)];
  return browser.json(approvePOST, `/api/tenants/${tenantId}/runs/${runId}/approve`, { code: totpNow(secret) }, { tenantId, runId });
}

async function approvedToken(runId: string, tenantId = "acme"): Promise<string> {
  const res = await approve(runId, tenantId);
  expect(res.status).toBe(200);
  return (await res.json()).approvalToken;
}

async function start(runId: string, approvalToken: string, tenantId = "acme") {
  return startRun(await mintAsBff("engine.startRun", tenantId), { tenantId, runId, approvalToken });
}

/** The run is untouched: still approved, nothing written, token unused. */
function expectUntouched(runId: string) {
  expect(runRow(runId).status).toBe("approved");
  expect(count("pay_result", runId)).toBe(0);
  expect(count("pay_exception", runId)).toBe(0);
  expect(tokenRedeemed(runId)).toBe(0);
}

const rejected = (p: Promise<unknown>) => expect(p).rejects.toBeInstanceOf(ApprovalRejectedError);

beforeAll(async () => {
  useFakeClock();
  approver = new Browser();
  await staffLogin(approver, "acme", acme.approver.email, seededPassword(acme.approver.email), seededTotpSecret(acme.approver.email));
  advance(31);
  globexApprover = new Browser();
  await staffLogin(globexApprover, "globex", globex.approver.email, seededPassword(globex.approver.email), seededTotpSecret(globex.approver.email));
});
afterAll(() => vi.useRealTimers());

describe("[L2-02] a token that is not exactly right never starts a run", () => {
  it("unsigned (alg none)", async () => {
    const runId = newDraftRun();
    const good = await approvedToken(runId);
    const header = base64url.encode(JSON.stringify({ alg: "none", kid: decodeProtectedHeader(good).kid }));
    await rejected(start(runId, `${header}.${good.split(".")[1]}.`));
    expectUntouched(runId);
  });

  it("tampered (payload changed after signing)", async () => {
    const runId = newDraftRun();
    const good = await approvedToken(runId);
    const [h, , sig] = good.split(".");
    const payload = base64url.encode(JSON.stringify({ ...decodeJwt(good), rh: "0".repeat(64) }));
    await rejected(start(runId, `${h}.${payload}.${sig}`));
    expectUntouched(runId);
  });

  async function resign(good: string, alg: string, key: Parameters<SignJWT["sign"]>[0]) {
    return new SignJWT(decodeJwt(good)).setProtectedHeader({ alg, kid: decodeProtectedHeader(good).kid }).sign(key);
  }

  it("wrong key (valid claims, signed by a key PayrollHub never issued)", async () => {
    const runId = newDraftRun();
    const good = await approvedToken(runId);
    await rejected(start(runId, await resign(good, "EdDSA", generateKeyPairSync("ed25519").privateKey)));
    expectUntouched(runId);
  });

  it("wrong algorithm (HS256 and ES256)", async () => {
    const runId = newDraftRun();
    const good = await approvedToken(runId);
    await rejected(start(runId, await resign(good, "HS256", new TextEncoder().encode("guessable-secret"))));
    await rejected(start(runId, await resign(good, "ES256", generateKeyPairSync("ec", { namedCurve: "prime256v1" }).privateKey)));
    expectUntouched(runId);
  });

  it("wrong tenant (acme's token presented for globex)", async () => {
    const runId = newDraftRun();
    const good = await approvedToken(runId);
    await rejected(start(runId, good, "globex"));
    await rejected(start(newDraftRun("globex"), good, "globex"));
    expectUntouched(runId);
  });

  it("wrong run (a token for run 1 presented for run 2)", async () => {
    const run1 = newDraftRun();
    const run2 = newDraftRun();
    const token1 = await approvedToken(run1);
    await approvedToken(run2);
    await rejected(start(run2, token1));
    expectUntouched(run1);
    expectUntouched(run2);
  });

  it("content mismatch: a pay rate changed after approval", async () => {
    const runId = newDraftRun();
    const token = await approvedToken(runId);
    const [employee] = idsFor("acme").employeeIds;
    withTenant("acme", () => db().prepare("UPDATE employee SET pay_rate_cents = pay_rate_cents + 1 WHERE employee_id = ?").run(employee));
    await expect(start(runId, token)).rejects.toMatchObject({ reason: "content_changed" });
    expect(runRow(runId)).toMatchObject({ status: "failed", failure_reason: "content_changed" });
    expect(count("pay_result", runId)).toBe(0);
    expect(tokenRedeemed(runId)).toBe(1); // burned: this approval can never be used
    withTenant("acme", () => db().prepare("UPDATE employee SET pay_rate_cents = pay_rate_cents - 1 WHERE employee_id = ?").run(employee));
  });

  it("[L2-11 DiD] content mismatch: a bank change confirmed after approval (intended: it needs re-approval)", async () => {
    const runId = newDraftRun();
    const token = await approvedToken(runId);
    const [employee] = idsFor("acme").employeeIds;
    // What Layer 7's confirmation will do: the new account becomes verified and the old one is retired.
    withTenant("acme", (s) => {
      db().prepare("UPDATE bank_account SET status = 'retired' WHERE employee_id = ? AND status = 'verified'").run(employee);
      insertVerifiedAccount(s, employee, { routingNumber: "011000015", accountNumber: "730100009999" }, new Date());
    });
    await expect(start(runId, token)).rejects.toBeInstanceOf(RunFailedError);
    expect(runRow(runId)).toMatchObject({ status: "failed", failure_reason: "content_changed" });
    expect(count("pay_result", runId)).toBe(0);

    // Re-approval covers the new account, and the run then completes.
    const again = await approvedToken(runId);
    expect((await start(runId, again)).employeesPaid).toBe(3);
    expect(db().prepare("SELECT count(*) AS n FROM pay_result r JOIN bank_account b ON b.bank_account_id = r.bank_account_id WHERE r.run_id = ? AND b.status = 'retired'").get(runId)).toEqual({ n: 0 });
  });

  it("[L2-18] a retired key (after rotation)", async () => {
    const runId = newDraftRun();
    const good = await approvedToken(runId);
    rotateSigningKey("approval-token");
    await rejected(start(runId, good));
    expectUntouched(runId);
  });
});

describe("[L2-02 DiD] D27: separation of duties", () => {
  it("the creator of a run cannot approve it, in the service and in the database", async () => {
    const approverUserId = withTenant("acme", (s) => listUsers(s).find((u) => u.role === "approver")!.userId);
    const runId = newDraftRun("acme", approverUserId);
    const res = await approve(runId);
    expect([res.status, (await res.json()).error]).toEqual([409, "The person who created a run cannot approve it"]);
    expect(runRow(runId).status).toBe("draft");
    withTenant("acme", () => {
      expect(() => db().prepare("UPDATE payroll_run SET status = 'approved', approved_by = created_by WHERE run_id = ?").run(runId)).toThrow(/separation of duties/);
      expect(() =>
        db()
          .prepare("INSERT INTO payroll_run (run_id, tenant_id, pay_date, scheduled_run_date, status, created_by, approved_by) VALUES (?, 'acme', '2026-12-04', '2026-12-03', 'approved', ?, ?)")
          .run(randomUUID(), approverUserId, approverUserId),
      ).toThrow(/separation of duties/);
    });
  });
});

describe("[L2-02] D28: the run-content hash is canonical", () => {
  const content: RunContent = {
    tenantId: "acme",
    runId: "r1",
    payDate: "2026-11-27",
    scheduledRunDate: "2026-11-26",
    createdBy: "u1",
    withholdingRateBp: 2200,
    employees: [
      { employeeId: "b", payRateCents: 200, bankAccountId: "acct-b" },
      { employeeId: "a", payRateCents: 100, bankAccountId: null },
    ],
  };

  it("identical data gives the same hash regardless of list order", () => {
    const reordered = { ...content, employees: [...content.employees].reverse() };
    expect(runContentHash(reordered)).toBe(runContentHash(content));
    expect(canonicalRunContent(content)).toBe('["payrollhub.run-content.v1","acme","r1","2026-11-27","2026-11-26","u1",2200,[["a",100,null],["b",200,"acct-b"]]]');
  });

  it("any change in what was approved changes the hash", () => {
    const base = runContentHash(content);
    const variants: RunContent[] = [
      { ...content, payDate: "2026-11-28" },
      { ...content, withholdingRateBp: 2201 },
      { ...content, employees: [content.employees[0]] },
      { ...content, employees: [{ ...content.employees[0], payRateCents: 201 }, content.employees[1]] },
      { ...content, employees: [content.employees[0], { ...content.employees[1], bankAccountId: "acct-a" }] },
    ];
    for (const v of variants) expect(runContentHash(v)).not.toBe(base);
  });
});

describe("a successful run produces exactly one correct set of results", () => {
  it("hand-checked gross-to-net, with half-up rounding (acme, 22% withholding)", async () => {
    const runId = newDraftRun();
    const outcome = await start(runId, await approvedToken(runId));
    // alice 312,500 x 22% = 68,750.00 -> net 243,750
    // bob   287,500 x 22% = 63,250.00 -> net 224,250
    // carol 341,667 x 22% = 75,166.74 -> 75,167 (rounded up) -> net 266,500
    const rows = db()
      .prepare("SELECT e.full_name AS name, r.gross_pay_cents AS gross, r.net_pay_cents AS net FROM pay_result r JOIN employee e ON e.employee_id = r.employee_id WHERE r.run_id = ? ORDER BY e.full_name")
      .all(runId);
    expect(rows).toEqual([
      { name: "Alice Anders", gross: 312_500, net: 243_750 },
      { name: "Bob Brandt", gross: 287_500, net: 224_250 },
      { name: "Carol Chen", gross: 341_667, net: 266_500 },
    ]);
    expect(outcome).toMatchObject({ status: "computed", employeesPaid: 3, totalGrossCents: 941_667, totalNetCents: 734_500, exceptions: [] });
    expect(runRow(runId).status).toBe("computed");
  });

  it("the rounding rule at the edges", () => {
    expect(computePay(312_525, 2200)).toEqual({ grossCents: 312_525, withholdingCents: 68_756, netCents: 243_769 }); // 68,755.50 -> up
    expect(computePay(1, 5000)).toEqual({ grossCents: 1, withholdingCents: 1, netCents: 0 }); // 0.5 -> 1; net never below 0
    expect(computePay(1, 4999)).toEqual({ grossCents: 1, withholdingCents: 0, netCents: 1 }); // 0.4999 -> 0
    expect(computePay(100, 10_000)).toEqual({ grossCents: 100, withholdingCents: 100, netCents: 0 });
    expect(computePay(358_333, 2000)).toEqual({ grossCents: 358_333, withholdingCents: 71_667, netCents: 286_666 }); // 71,666.6 -> up
    expect(() => computePay(10.5, 2200)).toThrow();
    expect(() => computePay(100, 10_001)).toThrow();
  });

  it("[L2-11] an employee without a verified account is reported, not skipped or paid elsewhere", async () => {
    const userId = randomUUID();
    const employeeId = randomUUID();
    withTenant("globex", (s) => {
      insertUser(s, { userId, email: "gus@globex.test", role: "employee", mfaEnrolled: false, ssoSubject: "globex-idp|gus@globex.test", status: "active", passwordHash: null });
      insertEmployee(s, { employeeId, userId, fullName: "Gus Grant", status: "active", payRateCents: 300_000 });
    });
    const runId = newDraftRun("globex");
    const outcome = await start(runId, await approvedToken(runId, "globex"), "globex");
    expect(outcome.exceptions).toEqual([{ employeeId, reason: "no_verified_bank_account" }]);
    expect(outcome.employeesPaid).toBe(3);
    expect(db().prepare("SELECT employee_id, reason FROM pay_exception WHERE run_id = ?").all(runId)).toEqual([{ employee_id: employeeId, reason: "no_verified_bank_account" }]);
    expect(db().prepare("SELECT count(*) AS n FROM pay_result WHERE run_id = ? AND employee_id = ?").get(runId, employeeId)).toEqual({ n: 0 });
  });

  it("[L2-01] running the same approved run twice: the second attempt changes nothing", async () => {
    const runId = newDraftRun();
    const token = await approvedToken(runId);
    await start(runId, token);
    const second = await start(runId, token).then(() => null, (e: unknown) => e);
    expect(second instanceof ConflictError || second instanceof ApprovalRejectedError).toBe(true);
    expect((await approve(runId)).status).toBe(409); // cannot be approved again either
    expect(count("pay_result", runId)).toBe(3);
    expect(() => withTenant("acme", () => db().prepare("UPDATE pay_result SET net_pay_cents = 1 WHERE run_id = ?").run(runId))).toThrow(/immutable/);
  });
});

describe("[L2-02 DiD] the request cannot supply amounts, employees, or accounts", () => {
  it("extra fields in the start request are rejected (strict schema) and nothing changes", async () => {
    const runId = newDraftRun();
    const token = await approvedToken(runId);
    const injected = { approvalToken: token, grossPayCents: 1, employees: [{ employeeId: "x", payRateCents: 9_999_999 }], bankAccountId: randomUUID() };
    const viaBff = await approver.json(startPOST, `/api/tenants/acme/runs/${runId}/start`, injected, { tenantId: "acme", runId });
    expect(viaBff.status).toBe(400);
    const viaInternal = await engineStartPOST(
      new NextRequest(`http://localhost:3000/api/internal/engine/tenants/acme/runs/${runId}/start`, {
        method: "POST",
        body: JSON.stringify(injected),
        headers: { "content-type": "application/json", authorization: `Bearer ${await mintAsBff("engine.startRun", "acme")}` },
      }),
      { params: Promise.resolve({ tenantId: "acme", runId }) },
    );
    expect(viaInternal.status).toBe(400);
    expectUntouched(runId);
    // The legitimate request still works, with amounts from the database.
    expect((await start(runId, token)).totalGrossCents).toBe(941_667);
  });
});

describe("[L2-02 DiD] [L1-19 DiD] the BFF reaches the engine only through /api/internal/engine", () => {
  it("calls the configured internal origin with a single-use service token, whatever Host the client sent", async () => {
    const runId = newDraftRun();
    const token = await approvedToken(runId);
    const seen: { url: string; auth: string | null }[] = [];
    const realFetch = globalThis.fetch;
    vi.stubGlobal("fetch", async (input: URL | string, init?: RequestInit) => {
      const url = String(input);
      seen.push({ url, auth: new Headers(init?.headers).get("authorization") });
      const req = new NextRequest(url, init as never);
      // /api/internal/engine/tenants/<tenantId>/runs/<runId>/start
      const parts = new URL(url).pathname.split("/");
      const [tenantId, runIdParam] = [parts[5], parts[7]];
      return engineStartPOST(req, { params: Promise.resolve({ tenantId, runId: runIdParam }) });
    });
    try {
      // The client addresses the request to a host it controls; the BFF must still call the configured internal origin.
      const cookie = [...approver.jar].map(([k, v]) => `${k}=${v}`).join("; ");
      const res = await startPOST(
        new NextRequest(`http://evil.example/api/tenants/acme/runs/${runId}/start`, {
          method: "POST",
          body: JSON.stringify({ approvalToken: token }),
          headers: { "content-type": "application/json", origin: "http://evil.example", cookie },
        }),
        { params: Promise.resolve({ tenantId: "acme", runId }) },
      );
      expect(res.status).toBe(200);
      expect((await res.json()).employeesPaid).toBe(3);
    } finally {
      vi.stubGlobal("fetch", realFetch);
    }
    expect(seen).toHaveLength(1);
    expect(seen[0].url).toBe(`http://127.0.0.1:3000/api/internal/engine/tenants/acme/runs/${runId}/start`);
    expect(seen[0].auth).toMatch(/^Bearer /);
  });

  it("[L2-02] only the approver the token was issued to can present it", async () => {
    const runId = newDraftRun();
    const token = await approvedToken(runId);
    const res = await globexApprover.json(startPOST, `/api/tenants/globex/runs/${runId}/start`, { approvalToken: token }, { tenantId: "globex", runId });
    expect(res.status).toBe(403);
    expectUntouched(runId);
  });
});

// Last in the file: it moves the clock days ahead, and TOTP steps and sessions can only move forward.
describe("[L0-11 DiD] day-early schedule (D29): a late start is allowed and flagged", () => {
  it("a run started after its scheduled run date computes, returns late: true, and logs a warning", async () => {
    const runId = randomUUID();
    const { hrAdminId } = idsFor("acme");
    withTenant("acme", (s) => insertPayrollRun(s, { runId, payDate: "2026-10-20", status: "draft", createdBy: hrAdminId, approvedBy: null }));
    vi.setSystemTime(new Date("2026-10-20T09:00:00Z")); // the pay date itself, after the 2026-10-19 scheduled run date
    approver = new Browser();
    await staffLogin(approver, "acme", acme.approver.email, seededPassword(acme.approver.email), seededTotpSecret(acme.approver.email));
    const token = await approvedToken(runId);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const outcome = await start(runId, token);
    expect(outcome).toMatchObject({ status: "computed", late: true });
    expect(warn.mock.calls.some(([m]) => String(m).includes("engine.run_started_late"))).toBe(true);
    warn.mockRestore();
  });
});
