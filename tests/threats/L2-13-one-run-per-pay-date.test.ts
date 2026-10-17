import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { POST as ssoCallbackPOST } from "@/app/api/auth/sso/[tenantId]/callback/route";
import { POST as confirmPOST } from "@/app/api/tenants/[tenantId]/bank-account/changes/[changeId]/confirm/route";
import { POST as adminChangePOST } from "@/app/api/tenants/[tenantId]/employees/[employeeId]/bank-account/changes/route";
import { POST as approvePOST } from "@/app/api/tenants/[tenantId]/runs/[runId]/approve/route";
import { POST as editRunPOST } from "@/app/api/tenants/[tenantId]/runs/[runId]/route";
import { POST as createRunPOST } from "@/app/api/tenants/[tenantId]/runs/route";
import { POST as idpLoginPOST } from "@/app/mock-idp/[tenantId]/login/route";
import { mintAsBff } from "@/application/mint-as-bff";
import { withTenant } from "@/data/db/tenant-scope";
import type { MockBank } from "@/partners/mock-bank/server";
import { openMailbox } from "@/partners/mock-mail/mail";
import { SEED_TENANTS, mailboxPasswordFor, seededIdpPassword, seededPassword, seededTotpSecret } from "@/scripts/lib/seed";
import { startRun } from "@/services/engine/engine-service";
import { listEmployees } from "@/services/engine/repository";
import { ConflictError, RunFailedError } from "@/services/errors";
import { listUsers } from "@/services/identity/repository";
import { batchRows, computedRun, disburse, runStatus, startBank } from "../helpers/ach";
import { idsFor, rawSqlite, setupSeededDatabase } from "../helpers/database";
import { Browser, advance, location, staffLogin, totpNow, useFakeClock } from "../helpers/http";

// RT-01 (Turn 13 red team, L2-13): two runs created for the same pay date could each be approved, run, and sent, so
// every employee was paid twice. ACH idempotency is per run; this is the per-pay-period half: at most one live run
// (any status except failed) per tenant and pay date, enforced by a partial unique index and checked when a run is
// created, moved to another date, or approved.

setupSeededDatabase();

const [acme, globex] = SEED_TENANTS;
const aliceSeed = acme.employees[0];
let admin: Browser;
let globexAdmin: Browser;
let approver: Browser;
let bank: MockBank;

const create = (browser: Browser, payDate: string, tenantId = "acme") =>
  browser.json(createRunPOST, `/api/tenants/${tenantId}/runs`, { payDate }, { tenantId });
/** Raw SQL inside acme's tenant scope: past the repository and services, so only the database's own rules apply. */
const sqlInAcme = (statement: string, ...params: unknown[]) => withTenant("acme", () => rawSqlite().prepare(statement).run(...params));
const insertRaw = (runId: string, payDate: string, status: string) =>
  sqlInAcme(
    "INSERT INTO payroll_run (run_id, tenant_id, pay_date, scheduled_run_date, status, created_by, approved_by) VALUES (?, 'acme', ?, date(?, '-1 day'), ?, ?, ?)",
    runId, payDate, payDate, status, idsFor("acme").hrAdminId, status === "draft" ? null : approverId(),
  );
const approverId = () => (rawSqlite().prepare("SELECT user_id FROM app_user WHERE email = ?").get(acme.approver.email) as { user_id: string }).user_id;

// The real flow, through the routes and services a user's actions reach.
async function createdRunId(payDate: string): Promise<string> {
  const res = await create(admin, payDate);
  expect(res.status).toBe(201);
  return (await res.json()).runId;
}
async function approve(runId: string) {
  advance(31); // a fresh TOTP time step for the step-up
  return approver.json(approvePOST, `/api/tenants/acme/runs/${runId}/approve`, { code: totpNow(seededTotpSecret(acme.approver.email)) }, { tenantId: "acme", runId });
}
async function approvalToken(runId: string): Promise<string> {
  const res = await approve(runId);
  expect(res.status).toBe(200);
  return (await res.json()).approvalToken;
}
const start = async (runId: string, token: string) => startRun(await mintAsBff("engine.startRun", "acme"), { tenantId: "acme", runId, approvalToken: token });
const approveAndStart = async (runId: string) => start(runId, await approvalToken(runId));

const aliceEmployeeId = () =>
  withTenant("acme", (s) => {
    const user = listUsers(s).find((u) => u.email === aliceSeed.email)!;
    return listEmployees(s).find((e) => e.userId === user.userId)!.employeeId;
  });
const aliceVerifiedAccount = () =>
  (rawSqlite().prepare("SELECT bank_account_id FROM bank_account WHERE employee_id = ? AND status = 'verified'").get(aliceEmployeeId()) as { bank_account_id: string }).bank_account_id;
const paidAccount = (runId: string, employeeId: string) =>
  (rawSqlite().prepare("SELECT bank_account_id FROM pay_result WHERE run_id = ? AND employee_id = ?").get(runId, employeeId) as { bank_account_id: string }).bank_account_id;

let nextAccount = 0;
/** The HR Admin enters a new account for Alice; she signs in through her IdP and confirms it from her mailbox. */
async function bankChangeConfirmed() {
  const accountNumber = `7777${String(++nextAccount).padStart(6, "0")}`;
  const employeeId = aliceEmployeeId();
  const requested = await admin.json(adminChangePOST, `/api/tenants/acme/employees/${employeeId}/bank-account/changes`, { routingNumber: "091000019", accountNumber }, { tenantId: "acme", employeeId });
  expect(requested.status).toBe(201);
  const mail = (await openMailbox(aliceSeed.email, mailboxPasswordFor(aliceSeed.email)))!;
  const [, changeId, token] = mail.find((m) => m.subject.startsWith("Confirm"))!.body.match(/\/employee\/bank-change\/([0-9a-f-]{36})\?token=([A-Za-z0-9_-]+)/)!;
  const alice = new Browser();
  const idp = await alice.post(idpLoginPOST, "/mock-idp/acme/login", { email: aliceSeed.email, password: seededIdpPassword(aliceSeed.email) }, { tenantId: "acme" });
  const assertion = (await idp.text()).match(/name="assertion" value="([^"]+)"/)![1];
  await alice.post(ssoCallbackPOST, "/api/auth/sso/acme/callback", { assertion }, { tenantId: "acme" });
  const confirmed = await alice.post(confirmPOST, `/api/tenants/acme/bank-account/changes/${changeId}/confirm`, { token }, { tenantId: "acme", changeId });
  expect(location(confirmed)).toBe("/employee?bank=confirmed");
}

beforeAll(async () => {
  bank = await startBank();
  useFakeClock();
  admin = new Browser();
  await staffLogin(admin, "acme", acme.hrAdmin.email, seededPassword(acme.hrAdmin.email), seededTotpSecret(acme.hrAdmin.email));
  globexAdmin = new Browser();
  await staffLogin(globexAdmin, "globex", globex.hrAdmin.email, seededPassword(globex.hrAdmin.email), seededTotpSecret(globex.hrAdmin.email));
  approver = new Browser();
  await staffLogin(approver, "acme", acme.approver.email, seededPassword(acme.approver.email), seededTotpSecret(acme.approver.email));
});
afterAll(() => bank.close());

describe("[L2-13] one live run per tenant and pay date (RT-01)", () => {
  it("the Turn 13 reproduction: after one run for a pay date is paid, a second run for that date cannot be created", async () => {
    const runId = await computedRun(approver, "acme", "2026-12-04");
    expect((await disburse(runId)).status).toBe("sent");
    expect(bank.accepted()).toHaveLength(1);

    const second = await create(admin, "2026-12-04");
    expect(second.status).toBe(409);
    expect(bank.accepted()).toHaveLength(1);
  });

  it("two drafts for one pay date are refused at creation, before anyone can approve either", async () => {
    expect((await create(admin, "2026-12-11")).status).toBe(201);
    const again = await create(admin, "2026-12-11");
    expect(again.status).toBe(409);
    expect(await again.json()).toEqual({ error: "A payroll run already exists for this pay date" });
  });

  it("the database refuses a second live run for the same tenant and pay date, whatever the caller", () => {
    insertRaw(randomUUID(), "2027-01-08", "draft");
    for (const status of ["draft", "approved", "computed", "disbursed"]) {
      expect(() => insertRaw(randomUUID(), "2027-01-08", status)).toThrow(/UNIQUE constraint failed/);
    }
  });

  it("moving a draft onto another live run's pay date is refused", async () => {
    const draft = await (await create(admin, "2027-01-15")).json();
    expect((await create(admin, "2027-01-22")).status).toBe(201);
    const moved = await admin.json(editRunPOST, `/api/tenants/acme/runs/${draft.runId}`, { payDate: "2027-01-22" }, { tenantId: "acme", runId: draft.runId });
    expect(moved.status).toBe(409);
  });

  it("a failed run does not block a new run for its date (D35), and cannot be approved again while that run is live", async () => {
    const failed = randomUUID();
    insertRaw(failed, "2027-02-05", "draft");
    sqlInAcme("UPDATE payroll_run SET status = 'approved', approved_by = ? WHERE run_id = ?", approverId(), failed);
    sqlInAcme("UPDATE payroll_run SET status = 'failed', failure_reason = 'content_changed' WHERE run_id = ?", failed);

    expect((await create(admin, "2027-02-05")).status).toBe(201);
    advance(31);
    const reapprove = await approver.json(approvePOST, `/api/tenants/acme/runs/${failed}/approve`, { code: totpNow(seededTotpSecret(acme.approver.email)) }, { tenantId: "acme", runId: failed });
    expect(reapprove.status).toBe(409);
  });

  it("end to end (D35): a run that fails at send is replaced by a new run for the same pay date, which pays once", async () => {
    const payDate = "2027-04-02";
    const sentBefore = bank.accepted().length;
    const failedRun = await createdRunId(payDate);
    await approveAndStart(failedRun);

    // Alice confirms a bank change between compute and send, so the computed run must not be paid (D35).
    await bankChangeConfirmed();
    const failure = await disburse(failedRun).catch((e: unknown) => e);
    expect(failure).toBeInstanceOf(RunFailedError);
    expect((failure as RunFailedError).reason).toBe("bank_account_changed");
    expect(runStatus(failedRun)).toEqual({ status: "failed", failure_reason: "bank_account_changed" });

    // The failed run is not live, so HR can create the replacement run for the same pay date; it pays once.
    const rerun = await createdRunId(payDate);
    await approveAndStart(rerun);
    expect((await disburse(rerun)).status).toBe("sent");
    expect(bank.accepted().slice(sentBefore).map((b) => b.batchId)).toEqual(batchRows(rerun).map((b) => b.batch_id));
    expect(batchRows(failedRun)).toEqual([]);
    expect(paidAccount(rerun, aliceEmployeeId())).toBe(aliceVerifiedAccount());

    // The failed run stays closed, and the date stays taken.
    expect((await approve(failedRun)).status).toBe(409);
    await expect(disburse(failedRun)).rejects.toBeInstanceOf(ConflictError);
    expect((await create(admin, payDate)).status).toBe(409);
    expect(bank.accepted()).toHaveLength(sentBefore + 1);
  });

  it("end to end: a run that fails at compute is replaced by a new run for the same pay date; the old one cannot come back", async () => {
    const payDate = "2027-04-09";
    const failedRun = await createdRunId(payDate);
    const staleToken = await approvalToken(failedRun);

    // A bank change confirmed after approval changes the run's content (D28): Payroll Engine fails the run.
    await bankChangeConfirmed();
    const failure = await start(failedRun, staleToken).catch((e: unknown) => e);
    expect((failure as RunFailedError).reason).toBe("content_changed");
    expect(runStatus(failedRun)).toEqual({ status: "failed", failure_reason: "content_changed" });

    const rerun = await createdRunId(payDate);
    await approveAndStart(rerun);
    expect(runStatus(rerun).status).toBe("computed");

    // While the replacement is live, the failed run cannot be approved again (which would make two live runs).
    const reapprove = await approve(failedRun);
    expect(reapprove.status).toBe(409);
    expect(await reapprove.json()).toEqual({ error: "Another payroll run is live for this pay date" });
    expect(runStatus(failedRun).status).toBe("failed");
  });

  it("another tenant, or another pay date, is unaffected", async () => {
    expect((await create(admin, "2027-03-05")).status).toBe(201);
    expect((await create(globexAdmin, "2027-03-05", "globex")).status).toBe(201);
    expect((await create(admin, "2027-03-12")).status).toBe(201);
  });
});
