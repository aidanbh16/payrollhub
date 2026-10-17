import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { POST as approvePOST } from "@/app/api/tenants/[tenantId]/runs/[runId]/approve/route";
import { mintAsBff } from "@/application/mint-as-bff";
import { withTenant } from "@/data/db/tenant-scope";
import { SEED_TENANTS, seededPassword, seededTotpSecret } from "@/scripts/lib/seed";
import { startRun } from "@/services/engine/engine-service";
import { insertPayrollRun } from "@/services/engine/repository";
import { RunFailedError } from "@/services/errors";
import { idsFor, rawSqlite, setupSeededDatabase } from "../helpers/database";
import { Browser, advance, staffLogin, totpNow, useFakeClock } from "../helpers/http";

// A failure in the middle of computing a run (here: on the second employee) must leave no partial results, no
// "burned but unused" approval, and a clear failed state that needs re-approval.

const failure = vi.hoisted(() => ({ calls: 0, failOnCall: 0 }));
vi.mock("@/services/engine/pay-calc", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/services/engine/pay-calc")>();
  return {
    ...real,
    computePay: (gross: number, rate: number) => {
      failure.calls += 1;
      if (failure.failOnCall && failure.calls === failure.failOnCall) throw new Error("simulated failure while computing pay");
      return real.computePay(gross, rate);
    },
  };
});

setupSeededDatabase();

const [acme] = SEED_TENANTS;
let approver: Browser;
const q = (sql: string, ...args: unknown[]) => rawSqlite().prepare(sql).get(...args) as Record<string, unknown>;

beforeAll(async () => {
  useFakeClock();
  approver = new Browser();
  await staffLogin(approver, "acme", acme.approver.email, seededPassword(acme.approver.email), seededTotpSecret(acme.approver.email));
});
afterAll(() => vi.useRealTimers());

async function approvedToken(runId: string) {
  advance(31);
  const res = await approver.json(approvePOST, `/api/tenants/acme/runs/${runId}/approve`, { code: totpNow(seededTotpSecret(acme.approver.email)) }, { tenantId: "acme", runId });
  expect(res.status).toBe(200);
  return (await res.json()).approvalToken as string;
}

const start = async (runId: string, approvalToken: string) =>
  startRun(await mintAsBff("engine.startRun", "acme"), { tenantId: "acme", runId, approvalToken });

describe("[L2-02] [L2-01 DiD] a forced failure mid-computation", () => {
  it("leaves no partial results and a clear failed state; re-approval then completes the run once", async () => {
    const runId = randomUUID();
    const { hrAdminId } = idsFor("acme");
    withTenant("acme", (s) => insertPayrollRun(s, { runId, payDate: "2026-11-27", status: "draft", createdBy: hrAdminId, approvedBy: null }));
    const token = await approvedToken(runId);

    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    failure.calls = 0;
    failure.failOnCall = 2; // the first employee's pay is computed, then the second one throws
    await expect(start(runId, token)).rejects.toMatchObject({ reason: "computation_error" });
    expect(failure.calls).toBe(2);
    expect(log).toHaveBeenCalled();
    log.mockRestore();

    expect(q("SELECT count(*) AS n FROM pay_result WHERE run_id = ?", runId)).toEqual({ n: 0 }); // not even the first one
    expect(q("SELECT count(*) AS n FROM pay_exception WHERE run_id = ?", runId)).toEqual({ n: 0 });
    expect(q("SELECT status, failure_reason FROM payroll_run WHERE run_id = ?", runId)).toEqual({ status: "failed", failure_reason: "computation_error" });
    expect(q("SELECT count(*) AS n FROM approval_token WHERE run_id = ? AND redeemed_at IS NOT NULL", runId)).toEqual({ n: 1 });

    // The failed approval cannot be retried; the run needs a new approval.
    failure.failOnCall = 0;
    await expect(start(runId, token)).rejects.not.toBeInstanceOf(RunFailedError);
    expect(q("SELECT status FROM payroll_run WHERE run_id = ?", runId)).toEqual({ status: "failed" });

    const again = await approvedToken(runId);
    expect(q("SELECT status, failure_reason FROM payroll_run WHERE run_id = ?", runId)).toEqual({ status: "approved", failure_reason: null });
    const outcome = await start(runId, again);
    expect(outcome).toMatchObject({ status: "computed", employeesPaid: 3 });
    expect(q("SELECT count(*) AS n FROM pay_result WHERE run_id = ?", runId)).toEqual({ n: 3 });
  });
});
