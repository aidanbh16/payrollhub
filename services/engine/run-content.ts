import "server-only";
import { createHash } from "node:crypto";
import type { TenantScope } from "@/data/db/tenant-scope";
import type { VerifiedAccountRef } from "@/services/bank-account/bank-account-service";
import { getTenant } from "@/services/identity/repository";
import { listEmployees, type getPayrollRun } from "./repository";

// D28: what an approval covers. The approval token carries a SHA-256 of this content, and Payroll Engine recomputes it
// before computing anything; any difference (a pay rate, the employee list, a confirmed bank change, the withholding
// rate, or the run itself) means the token no longer matches and the run needs to be approved again.
//
// Canonical form, so identical data always gives the same hash: a JSON array (never an object, so no key-order
// question) with a version tag, fixed field order, employees sorted by id with plain code-unit comparison (not locale),
// integers for money, null for "no verified account", encoded as UTF-8.

export const RUN_CONTENT_VERSION = "payrollhub.run-content.v1";

export interface RunContentEmployee {
  employeeId: string;
  payRateCents: number;
  bankAccountId: string | null;
}

export interface RunContent {
  tenantId: string;
  runId: string;
  payDate: string;
  scheduledRunDate: string;
  createdBy: string;
  withholdingRateBp: number;
  employees: RunContentEmployee[];
}

const byId = (a: RunContentEmployee, b: RunContentEmployee) => (a.employeeId < b.employeeId ? -1 : a.employeeId > b.employeeId ? 1 : 0);

export function canonicalRunContent(c: RunContent): string {
  return JSON.stringify([
    RUN_CONTENT_VERSION,
    c.tenantId,
    c.runId,
    c.payDate,
    c.scheduledRunDate,
    c.createdBy,
    c.withholdingRateBp,
    [...c.employees].sort(byId).map((e) => [e.employeeId, e.payRateCents, e.bankAccountId]),
  ]);
}

export function runContentHash(c: RunContent): string {
  return createHash("sha256").update(canonicalRunContent(c), "utf8").digest("hex");
}

type Run = NonNullable<ReturnType<typeof getPayrollRun>>;

/** Reads a run's content from the database (inside the caller's tenant scope). Active employees only. */
export function loadRunContent(s: TenantScope, run: Run, accounts: VerifiedAccountRef[]): RunContent {
  const tenant = getTenant(s);
  if (!tenant) throw new Error("tenant not found");
  const accountOf = new Map(accounts.map((a) => [a.employeeId, a.bankAccountId]));
  const employees = listEmployees(s)
    .filter((e) => e.status === "active")
    .map((e) => ({ employeeId: e.employeeId, payRateCents: e.payRateCents, bankAccountId: accountOf.get(e.employeeId) ?? null }))
    .sort(byId);
  return {
    tenantId: s.tenantId,
    runId: run.runId,
    payDate: run.payDate,
    scheduledRunDate: run.scheduledRunDate,
    createdBy: run.createdBy,
    withholdingRateBp: tenant.withholdingRateBp,
    employees,
  };
}
