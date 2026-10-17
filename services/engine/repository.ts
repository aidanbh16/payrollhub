import "server-only";
import { and, eq, inArray } from "drizzle-orm";
import type { TenantInsert, TenantScope } from "@/data/db/tenant-scope";
import { vEmployee, vPayException, vPayResult, vPayrollRun } from "@/data/db/views";

// Payroll Engine repository (Section 3.2): employees, payroll runs, and pay results.

export function insertEmployee(s: TenantScope, values: TenantInsert<"employee">) {
  s.insert("employee", values);
}

export function listEmployees(s: TenantScope) {
  return s.read(vEmployee).all();
}

export function getEmployee(s: TenantScope, employeeId: string) {
  return s.read(vEmployee).where(eq(vEmployee.employeeId, employeeId)).get();
}

/** The day before an ISO date (YYYY-MM-DD). Every run is scheduled one day before its pay date (L0-11 backup). */
export function dayBefore(isoDate: string): string {
  const date = new Date(`${isoDate}T00:00:00Z`);
  if (Number.isNaN(date.getTime())) throw new Error("Invalid pay date");
  date.setUTCDate(date.getUTCDate() - 1);
  return date.toISOString().slice(0, 10);
}

export function insertPayrollRun(s: TenantScope, values: Omit<TenantInsert<"payrollRun">, "scheduledRunDate">) {
  s.insert("payrollRun", { ...values, scheduledRunDate: dayBefore(values.payDate) });
}

export function getPayrollRun(s: TenantScope, runId: string) {
  return s.read(vPayrollRun).where(eq(vPayrollRun.runId, runId)).get();
}

export function listPayrollRuns(s: TenantScope) {
  return s.read(vPayrollRun).all();
}

export function insertPayResults(s: TenantScope, values: TenantInsert<"payResult">[]) {
  if (values.length > 0) s.insert("payResult", values);
}

export function listPayResults(s: TenantScope, runId: string) {
  return s.read(vPayResult).where(eq(vPayResult.runId, runId)).all();
}

/** Changes a draft run's pay date. Returns false if the run is not a draft: approved runs cannot be edited. */
export function updateDraftRun(s: TenantScope, runId: string, payDate: string): boolean {
  const changed = s.update("payrollRun", { payDate, scheduledRunDate: dayBefore(payDate) }, (t) => and(eq(t.runId, runId), eq(t.status, "draft")));
  return changed === 1;
}

export function insertPayExceptions(s: TenantScope, values: TenantInsert<"payException">[]) {
  if (values.length > 0) s.insert("payException", values);
}

export function listPayExceptions(s: TenantScope, runId: string) {
  return s.read(vPayException).where(eq(vPayException.runId, runId)).all();
}

/** approved -> computed, in the same transaction that wrote the results. False if the run was not approved. */
export function markRunComputed(s: TenantScope, runId: string, now: Date): boolean {
  return s.update("payrollRun", { status: "computed", computedAt: now }, (t) => and(eq(t.runId, runId), eq(t.status, "approved"))) === 1;
}

/** approved -> failed, with a reason. The run then needs re-approval. */
export function markRunFailed(s: TenantScope, runId: string, reason: "content_changed" | "computation_error"): boolean {
  return s.update("payrollRun", { status: "failed", failureReason: reason }, (t) => and(eq(t.runId, runId), eq(t.status, "approved"))) === 1;
}

/** computed -> disbursed, once the run's ACH batch has been accepted by the bank (a trigger checks the batch). */
export function markRunDisbursed(s: TenantScope, runId: string): boolean {
  return s.update("payrollRun", { status: "disbursed" }, (t) => and(eq(t.runId, runId), eq(t.status, "computed"))) === 1;
}

/** computed -> failed: a paid-to account changed after the run was computed (D35). The run is closed for good. */
export function markComputedRunFailed(s: TenantScope, runId: string, reason: "bank_account_changed"): boolean {
  return s.update("payrollRun", { status: "failed", failureReason: reason }, (t) => and(eq(t.runId, runId), eq(t.status, "computed"))) === 1;
}

export function findEmployeeByUserId(s: TenantScope, userId: string) {
  return s.read(vEmployee).where(eq(vEmployee.userId, userId)).get();
}

/** One employee's pay results, across runs. */
export function listPayResultsForEmployee(s: TenantScope, employeeId: string) {
  return s.read(vPayResult).where(eq(vPayResult.employeeId, employeeId)).all();
}

export function getPayResult(s: TenantScope, resultId: string) {
  return s.read(vPayResult).where(eq(vPayResult.resultId, resultId)).get();
}

export function getPayrollRuns(s: TenantScope, runIds: string[]) {
  return runIds.length === 0 ? [] : s.read(vPayrollRun).where(inArray(vPayrollRun.runId, runIds)).all();
}
