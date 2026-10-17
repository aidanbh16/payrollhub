import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { POST as approvePOST } from "@/app/api/tenants/[tenantId]/runs/[runId]/approve/route";
import { POST as editRunPOST } from "@/app/api/tenants/[tenantId]/runs/[runId]/route";
import { POST as createRunPOST } from "@/app/api/tenants/[tenantId]/runs/route";
import { withTenant } from "@/data/db/tenant-scope";
import type { MockBank } from "@/partners/mock-bank/server";
import { SEED_TENANTS, seededPassword, seededTotpSecret } from "@/scripts/lib/seed";
import { computedRun, disburse, startBank } from "../helpers/ach";
import { idsFor, rawSqlite, setupSeededDatabase } from "../helpers/database";
import { Browser, advance, staffLogin, totpNow, useFakeClock } from "../helpers/http";

// RT-01 (Turn 13 red team, L2-13): two runs created for the same pay date could each be approved, run, and sent, so
// every employee was paid twice. ACH idempotency is per run; this is the per-pay-period half: at most one live run
// (any status except failed) per tenant and pay date, enforced by a partial unique index and checked when a run is
// created, moved to another date, or approved.

setupSeededDatabase();

const [acme, globex] = SEED_TENANTS;
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

  it("another tenant, or another pay date, is unaffected", async () => {
    expect((await create(admin, "2027-03-05")).status).toBe(201);
    expect((await create(globexAdmin, "2027-03-05", "globex")).status).toBe(201);
    expect((await create(admin, "2027-03-12")).status).toBe(201);
  });
});
