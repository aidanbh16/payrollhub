import { randomUUID } from "node:crypto";
import { NextRequest } from "next/server";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { POST as internalDisbursePOST } from "@/app/api/internal/ach/tenants/[tenantId]/runs/[runId]/disburse/route";
import { POST as approvePOST } from "@/app/api/tenants/[tenantId]/runs/[runId]/approve/route";
import { POST as disbursePOST } from "@/app/api/tenants/[tenantId]/runs/[runId]/disburse/route";
import { mintAsBff } from "@/application/mint-as-bff";
import { withTenant } from "@/data/db/tenant-scope";
import type { MockBank } from "@/partners/mock-bank/server";
import { SEED_TENANTS, seededPassword, seededTotpSecret } from "@/scripts/lib/seed";
import { achIdempotencyKey, batchIdFor } from "@/services/ach/ach-service";
import { AchFormatError, buildAchFile, checkControlTotals, readControls } from "@/services/ach/nacha";
import { getAchBatchForRun } from "@/services/ach/repository";
import { insertVerifiedAccount, listVerifiedAccounts, retireVerifiedAccounts } from "@/services/bank-account/repository";
import { insertPayrollRun, listPayResults } from "@/services/engine/repository";
import { BankUnavailableError, ConflictError, RunFailedError } from "@/services/errors";
import { batchRows, computedRun, disburse, runStatus, startBank } from "../helpers/ach";
import { idsFor, rawSqlite, setupSeededDatabase } from "../helpers/database";
import { Browser, advance, staffLogin, totpNow, useFakeClock } from "../helpers/http";

// L2-13 (High): a missing idempotency key double-submits the ACH batch and double-pays.
// Primary control: ACH Disbursement (services/ach/ach-service.ts) builds each batch under an idempotency key derived
// from the tenant and run, enforced by UNIQUE(run_id) and UNIQUE(idempotency_key); a retry or concurrent submit gets the
// existing batch, and the bank's duplicate check (batch ID inside the signed file) makes a repeated delivery harmless.

setupSeededDatabase();

const [acme] = SEED_TENANTS;
let approver: Browser;
let bank: MockBank;
const output: string[] = [];

const ledgerFor = (batchId: string) => bank.accepted().filter((b) => b.batchId === batchId);

beforeAll(async () => {
  for (const method of ["log", "info", "warn", "error", "debug"] as const) {
    vi.spyOn(console, method).mockImplementation((...args: unknown[]) => void output.push(args.map(String).join(" ")));
  }
  bank = await startBank();
  useFakeClock();
  approver = new Browser();
  await staffLogin(approver, "acme", acme.approver.email, seededPassword(acme.approver.email), seededTotpSecret(acme.approver.email));
});

afterAll(async () => {
  await bank.close();
  vi.restoreAllMocks();
});

describe("[L2-13] one run, at most one batch", () => {
  it("a double submit returns the one existing batch; the bank receives it once", async () => {
    const runId = await computedRun(approver);
    const first = await disburse(runId);
    expect(first).toMatchObject({ runId, status: "sent", signingKeyVersion: 1, bankReference: expect.stringMatching(/^BANK-/) });
    const second = await disburse(runId);
    expect(second).toEqual(first);
    expect(batchRows(runId)).toHaveLength(1);
    expect(ledgerFor(first.batchId)).toHaveLength(1);
    expect(runStatus(runId).status).toBe("disbursed");
    // The batch ID is derived from the tenant and run.
    expect(first.batchId).toBe(batchIdFor(achIdempotencyKey("acme", runId)));
  });

  it("concurrent submits produce one batch and one delivery", async () => {
    const runId = await computedRun(approver);
    const results = await Promise.all(Array.from({ length: 6 }, () => disburse(runId)));
    expect(new Set(results.map((r) => r.batchId)).size).toBe(1);
    expect(results.every((r) => r.status === "sent")).toBe(true);
    expect(batchRows(runId)).toHaveLength(1);
    expect(ledgerFor(results[0].batchId)).toHaveLength(1);
  });

  it("a retry after a timeout returns the existing batch; the bank's duplicate check absorbs the resend", async () => {
    const runId = await computedRun(approver);
    bank.setResponseDelay(3_000); // the bank accepts, but the answer arrives after PayrollHub's 1.5 s timeout
    const timedOut = await disburse(runId).catch((e: unknown) => e);
    bank.setResponseDelay(0);
    expect(timedOut).toBeInstanceOf(BankUnavailableError);
    const [row] = batchRows(runId);
    expect(row.status).toBe("signed"); // PayrollHub does not know whether it arrived
    expect(runStatus(runId).status).toBe("computed");
    expect(ledgerFor(row.batch_id)).toHaveLength(1); // it did arrive

    const retried = await disburse(runId);
    expect(retried).toMatchObject({ batchId: row.batch_id, status: "sent", bankReference: ledgerFor(row.batch_id)[0].bankReference });
    expect(batchRows(runId)).toHaveLength(1);
    expect(ledgerFor(row.batch_id)).toHaveLength(1);
    expect(runStatus(runId).status).toBe("disbursed");
  });

  it("the database refuses a second batch for a run, or a reused idempotency key", async () => {
    const runId = await computedRun(approver);
    const batch = await disburse(runId);
    const copy = (batchId: string, runSql: string, keySql: string) =>
      withTenant("acme", () =>
        rawSqlite()
          .prepare(`INSERT INTO ach_batch SELECT ?, tenant_id, ${runSql}, ${keySql}, file_body, signature, signing_key_version, 'signed', created_at, NULL, entry_count, total_credit_cents, NULL, NULL FROM ach_batch WHERE batch_id = ?`)
          .run(batchId, batch.batchId),
      );
    expect(() => copy(randomUUID(), "run_id", "'other-key'")).toThrow(/UNIQUE|computed run/);
    const other = await computedRun(approver);
    expect(() => copy(randomUUID(), `'${other}'`, "idempotency_key")).toThrow(/UNIQUE|totals/);
  });
});

describe("[L2-13] only a computed run, built from its pay results", () => {
  it("refuses a run that is not computed, creating nothing", async () => {
    const draft = randomUUID();
    const { hrAdminId } = idsFor("acme");
    withTenant("acme", (s) => insertPayrollRun(s, { runId: draft, payDate: "2026-11-27", status: "draft", createdBy: hrAdminId, approvedBy: null }));
    await expect(disburse(draft)).rejects.toThrow(new ConflictError("Only a computed run can be sent to the bank"));

    advance(31);
    const approve = await approver.json(approvePOST, `/api/tenants/acme/runs/${draft}/approve`, { code: totpNow(seededTotpSecret(acme.approver.email)) }, { tenantId: "acme", runId: draft });
    expect(approve.status).toBe(200);
    await expect(disburse(draft)).rejects.toBeInstanceOf(ConflictError); // approved, not computed
    expect(batchRows(draft)).toHaveLength(0);

    await expect(disburse(randomUUID())).rejects.toThrow(); // unknown run
  });

  it("batch totals equal the run's pay results, entry by entry, and the control records agree", async () => {
    const runId = await computedRun(approver);
    const batch = await disburse(runId);
    const results = withTenant("acme", (s) => listPayResults(s, runId));
    const accounts = new Map(withTenant("acme", (s) => listVerifiedAccounts(s)).map((a) => [a.bankAccountId, a]));
    const stored = withTenant("acme", (s) => getAchBatchForRun(s, runId))!;
    const c = readControls(stored.fileBody);

    const paid = results.filter((r) => r.netPayCents > 0);
    const total = results.reduce((sum, r) => sum + r.netPayCents, 0);
    expect(total).toBe(734_500); // Layer 6's hand-checked acme totals
    expect([c.entryCount, c.entrySumCents, c.batchControl.totalCreditCents, c.fileControl.totalCreditCents]).toEqual([paid.length, total, total, total]);
    expect([c.batchControl.entryCount, c.fileControl.entryCount, c.batchControl.totalDebitCents]).toEqual([paid.length, paid.length, 0]);
    expect([batch.entryCount, batch.totalCreditCents]).toEqual([paid.length, total]);
    expect(bank.accepted().find((b) => b.batchId === batch.batchId)).toMatchObject({ entryCount: paid.length, totalCreditCents: total });

    // Each entry pays one result's net amount into that result's verified account.
    const entries = stored.fileBody.split("\n").filter((l) => l.startsWith("6"));
    for (const r of paid) {
      const a = accounts.get(r.bankAccountId)!;
      const line = entries.find((e) => e.slice(3, 12) === a.routingNumber && e.slice(12, 29).trim() === a.accountNumber)!;
      expect(Number(line.slice(29, 39))).toBe(r.netPayCents);
    }
  });

  it("the totals check runs on the exact text before signing, and the database checks them again", () => {
    const entry = { routingNumber: "011000015", accountNumber: "730100000101", amountCents: 243_750, individualId: "E1", individualName: "Alice" };
    const input = { batchId: "BTEST000000000000001", originatingBank: { routingNumber: "011000028", name: "Bank" }, company: { id: "PHACME", name: "Acme" }, effectiveDate: "2026-11-27", createdAt: new Date(), entries: [entry] };
    const file = buildAchFile(input);
    expect(() => checkControlTotals(file, { batchId: input.batchId, entryCount: 1, totalCreditCents: 243_750 })).not.toThrow();
    expect(() => checkControlTotals(file, { batchId: input.batchId, entryCount: 1, totalCreditCents: 243_751 })).toThrow(AchFormatError);
    expect(() => checkControlTotals(file, { batchId: input.batchId, entryCount: 2, totalCreditCents: 243_750 })).toThrow(AchFormatError);
    // A file whose entry was changed after building, with control records left alone, fails.
    const altered = file.replace("0000243750", "0000943750");
    expect(() => checkControlTotals(altered, { batchId: input.batchId, entryCount: 1, totalCreditCents: 243_750 })).toThrow(AchFormatError);
    // A newline or field separator in a name cannot shift fields or add records.
    const sneaky = buildAchFile({ ...input, entries: [{ ...entry, individualName: "Al\n622011000015999999999" }] });
    expect(sneaky.split("\n").filter((l) => l.startsWith("6"))).toHaveLength(1);
    expect(() => checkControlTotals(sneaky, { batchId: input.batchId, entryCount: 1, totalCreditCents: 243_750 })).not.toThrow();
  });

  it("[L2-11 DiD] D35: an account retired after compute is not paid; the run is closed and cannot be approved again", async () => {
    const runId = await computedRun(approver);
    const [aliceResult] = withTenant("acme", (s) => listPayResults(s, runId));
    // The employee confirms a bank change after the run was computed.
    withTenant("acme", (s) => {
      retireVerifiedAccounts(s, aliceResult.employeeId);
      insertVerifiedAccount(s, aliceResult.employeeId, { routingNumber: "091000019", accountNumber: "555566667777" }, new Date());
    });
    const failed = await disburse(runId).catch((e: unknown) => e);
    expect(failed).toBeInstanceOf(RunFailedError);
    expect((failed as RunFailedError).reason).toBe("bank_account_changed");
    expect(runStatus(runId)).toEqual({ status: "failed", failure_reason: "bank_account_changed" });
    expect(batchRows(runId)).toHaveLength(0);

    advance(31);
    const again = await approver.json(approvePOST, `/api/tenants/acme/runs/${runId}/approve`, { code: totpNow(seededTotpSecret(acme.approver.email)) }, { tenantId: "acme", runId });
    expect(again.status).toBe(409);
    expect((await again.json()).error).toMatch(/Create a new run/);
    withTenant("acme", () =>
      expect(() => rawSqlite().prepare("UPDATE payroll_run SET status = 'approved' WHERE run_id = ?").run(runId)).toThrow(/invalid payroll run status change/),
    );
    // A new run pays everyone into their current verified accounts.
    const rerun = await computedRun(approver);
    expect((await disburse(rerun)).status).toBe("sent");
  });
});

describe("[L2-13 DiD] the request carries nothing, and nothing comes back but metadata", () => {
  const internal = async (body: string, runId: string) =>
    internalDisbursePOST(
      new NextRequest(`http://localhost:3000/api/internal/ach/tenants/acme/runs/${runId}/disburse`, {
        method: "POST",
        body,
        headers: { "content-type": "application/json", authorization: `Bearer ${await mintAsBff("ach.disburse", "acme")}` },
      }),
      { params: Promise.resolve({ tenantId: "acme", runId }) },
    );

  it("injected amounts or accounts are refused at the BFF and the internal route", async () => {
    const runId = await computedRun(approver);
    for (const extra of [{ totalCreditCents: 1 }, { accountNumber: "999999999999" }, { entries: [] }]) {
      expect((await approver.json(disbursePOST, `/api/tenants/acme/runs/${runId}/disburse`, extra, { tenantId: "acme", runId })).status).toBe(400);
      expect((await internal(JSON.stringify(extra), runId)).status).toBe(400);
    }
    expect(batchRows(runId)).toHaveLength(0);
  });

  it("the BFF calls the configured internal origin, and the response holds metadata only", async () => {
    const runId = await computedRun(approver);
    const realFetch = globalThis.fetch;
    const seen: string[] = [];
    vi.stubGlobal("fetch", async (input: URL | string, init?: RequestInit) => {
      seen.push(String(input));
      const parts = new URL(String(input)).pathname.split("/");
      return internalDisbursePOST(new NextRequest(String(input), init as never), { params: Promise.resolve({ tenantId: parts[5], runId: parts[7] }) });
    });
    let res: Response;
    try {
      res = await approver.json(disbursePOST, `/api/tenants/acme/runs/${runId}/disburse`, {}, { tenantId: "acme", runId });
    } finally {
      vi.stubGlobal("fetch", realFetch);
    }
    expect(seen).toEqual([`http://127.0.0.1:3000/api/internal/ach/tenants/acme/runs/${runId}/disburse`]);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Object.keys(body).sort()).toEqual(["bankReference", "batchId", "createdAt", "entryCount", "runId", "sentAt", "signingKeyVersion", "status", "totalCreditCents"]);
    const text = JSON.stringify(body);
    for (const e of acme.employees) expect(text).not.toContain(e.accountNumber);
    // An HR Admin or employee cannot send.
    const admin = new Browser();
    await staffLogin(admin, "acme", acme.hrAdmin.email, seededPassword(acme.hrAdmin.email), seededTotpSecret(acme.hrAdmin.email));
    expect((await admin.json(disbursePOST, `/api/tenants/acme/runs/${runId}/disburse`, {}, { tenantId: "acme", runId })).status).toBe(403);
  });

  it("[L2-12] no seeded account or routing number appears in any console output from this file", () => {
    const text = output.join("\n");
    expect(text).toContain("ach.batch_sent");
    for (const t of SEED_TENANTS) for (const e of t.employees) {
      expect(text).not.toContain(e.accountNumber);
      expect(text).not.toContain(e.routingNumber);
    }
  });
});
