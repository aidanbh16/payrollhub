import "server-only";
import { randomUUID } from "node:crypto";
import { withTenant, type TenantInsert, type TenantScope } from "@/data/db/tenant-scope";
import { prepareRedemption, redeemTicket, verifyApprovalToken } from "@/services/approval/approval-service";
import { accountEndings, openVerifiedAccountReader, readVerifiedAccounts, type VerifiedAccountReader } from "@/services/bank-account/bank-account-service";
import { ApprovalRejectedError, ConflictError, InvalidInputError, NotFoundError, RunFailedError, ServiceAuthError } from "@/services/errors";
import { authorizeServiceCall, type ServiceAuth } from "@/services/identity/service-tokens";
import { mintAsEngine } from "@/services/engine/mint-as-engine";
import { computePay } from "./pay-calc";
import {
  dayBefore, findEmployeeByUserId, findLiveRunForPayDate, getPayResult, getPayrollRun, getPayrollRuns, insertPayExceptions, insertPayResults, insertPayrollRun, listEmployees,
  listPayExceptions, listPayResults, listPayResultsForEmployee, listPayrollRuns, markRunComputed, markRunFailed, updateDraftRun,
} from "./repository";
import { loadRunContent, runContentHash } from "./run-content";
import { log } from "@/data/log/logger";

// Payroll Engine entry points (Assignment 5, Section 2.4). Every function verifies a scoped service token for its own
// endpoint first (L1-19) and works only inside the tenant named in that verified token.

export interface RunView {
  runId: string;
  payDate: string;
  scheduledRunDate: string;
  status: string;
  createdBy: string;
  approvedBy: string | null;
  failureReason: string | null;
  computedAt: string | null;
  /**
   * D29: the run is late. Once computed: it was computed after its scheduled (day-early) run date. Before that: it
   * would start late if started now. Late runs still proceed; the ACH batch may settle after the pay date.
   */
  late: boolean;
}

type RunRow = NonNullable<ReturnType<typeof getPayrollRun>>;

const toView = (r: RunRow, now = new Date()): RunView => ({
  runId: r.runId,
  payDate: r.payDate,
  scheduledRunDate: r.scheduledRunDate,
  status: r.status,
  createdBy: r.createdBy,
  approvedBy: r.approvedBy,
  failureReason: r.failureReason,
  computedAt: r.computedAt?.toISOString() ?? null,
  late: (r.computedAt ?? now).toISOString().slice(0, 10) > r.scheduledRunDate,
});

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function checkPayDate(payDate: string, now: Date) {
  if (!ISO_DATE.test(payDate) || Number.isNaN(Date.parse(`${payDate}T00:00:00Z`))) {
    throw new InvalidInputError("payDate must be a valid date (YYYY-MM-DD)");
  }
  if (dayBefore(payDate) <= now.toISOString().slice(0, 10)) {
    throw new InvalidInputError("payDate must be at least two days from today, so the run can finish a day before it");
  }
}

export const ONE_RUN_PER_PAY_DATE = "A payroll run already exists for this pay date";

/** Creates a draft payroll run. It is scheduled one day before the pay date, which must therefore be after today. */
export async function createDraftRun(
  auth: ServiceAuth,
  input: { tenantId: string; payDate: string; createdBy: string },
  now = new Date(),
): Promise<RunView> {
  const svc = await authorizeServiceCall(auth, { endpoint: "engine.createRun", tenantId: input.tenantId });
  checkPayDate(input.payDate, now);
  return withTenant(svc.tenantId, (s) => {
    // RT-01: one live run per pay date, so the same period can never be paid twice.
    if (findLiveRunForPayDate(s, input.payDate)) throw new ConflictError(ONE_RUN_PER_PAY_DATE);
    const runId = randomUUID();
    insertPayrollRun(s, { runId, payDate: input.payDate, status: "draft", createdBy: input.createdBy, approvedBy: null });
    return toView(getPayrollRun(s, runId)!);
  });
}

/** Reads one run. A run in another tenant is indistinguishable from one that does not exist. */
export async function getRun(auth: ServiceAuth, input: { tenantId: string; runId: string }): Promise<RunView> {
  const svc = await authorizeServiceCall(auth, { endpoint: "engine.getRun", tenantId: input.tenantId });
  const run = withTenant(svc.tenantId, (s) => getPayrollRun(s, input.runId));
  if (!run) throw new NotFoundError();
  return toView(run);
}

/** Changes a draft run. An approved (or later) run cannot be edited; the database enforces the same rule. */
export async function updateRun(auth: ServiceAuth, input: { tenantId: string; runId: string; payDate: string }, now = new Date()): Promise<RunView> {
  const svc = await authorizeServiceCall(auth, { endpoint: "engine.updateRun", tenantId: input.tenantId });
  checkPayDate(input.payDate, now);
  return withTenant(svc.tenantId, (s) => {
    const run = getPayrollRun(s, input.runId);
    if (!run) throw new NotFoundError();
    if (run.status !== "draft") throw new ConflictError("Only a draft run can be changed");
    if (findLiveRunForPayDate(s, input.payDate, input.runId)) throw new ConflictError(ONE_RUN_PER_PAY_DATE);
    if (!updateDraftRun(s, input.runId, input.payDate)) throw new ConflictError("Only a draft run can be changed");
    return toView(getPayrollRun(s, input.runId)!);
  });
}

export async function listRuns(auth: ServiceAuth, input: { tenantId: string }, now = new Date()): Promise<RunView[]> {
  const svc = await authorizeServiceCall(auth, { endpoint: "engine.listRuns", tenantId: input.tenantId });
  return withTenant(svc.tenantId, (s) => listPayrollRuns(s).map((r) => toView(r, now))).sort((a, b) => a.payDate.localeCompare(b.payDate));
}

// ---------- Running payroll (Assignment 5, Section 2.4 and Figure 6; L2-02) ----------

export interface RunOutcome {
  runId: string;
  status: "computed";
  employeesPaid: number;
  totalGrossCents: number;
  totalNetCents: number;
  /** Employees the run could not pay, reported rather than skipped or paid elsewhere. */
  exceptions: { employeeId: string; reason: "no_verified_bank_account" }[];
  /** Started after its scheduled (day-early) run date: the ACH batch may not settle by the pay date. */
  late: boolean;
}

/** Content changed after approval (D28). Internal: startRun turns it into RunFailedError("content_changed"). */
class ContentChangedError extends Error {}

/**
 * Starts an approved run. Order (each check before anything is written):
 *  1. the caller's single-use service token for engine.startRun;
 *  2. the approval token's signature, against the published key for its kid, algorithm pinned (L2-02), and its tenant
 *     and run; then Payroll Approval checks it again and returns a redemption ticket;
 *  3. inside ONE synchronous transaction: the run is approved by this token's approver and was not created by them
 *     (D27); the run's content, read now from the database, hashes to the token's `rh` (D28); Payroll Approval redeems
 *     the token atomically; every employee's pay is computed and all PayResult and PayException rows are written; the
 *     run moves to computed. If anything throws, SQLite rolls all of it back: no burned token, no partial results.
 *  4. If the content changed or the computation failed, a second transaction burns the token and marks the run
 *     `failed` with a reason, so it needs re-approval. A bad, replayed, or mismatched token changes nothing.
 * Amounts, employees, and accounts come only from the database; the caller supplies only the token.
 */
export async function startRun(auth: ServiceAuth, input: { tenantId: string; runId: string; approvalToken: string }, now = new Date()): Promise<RunOutcome> {
  const svc = await authorizeServiceCall(auth, { endpoint: "engine.startRun", tenantId: input.tenantId });
  const claims = await verifyApprovalToken(input.approvalToken);
  if (claims.tenantId !== svc.tenantId) throw new ApprovalRejectedError("token is for another tenant");
  if (claims.runId !== input.runId) throw new ApprovalRejectedError("token is for another run");
  const ticket = await prepareRedemption(await mintAsEngine("approval.redeemToken", svc.tenantId), input, now);
  const reader = await openVerifiedAccountReader(await mintAsEngine("bankAccount.readVerified", svc.tenantId), { tenantId: svc.tenantId }, now);

  try {
    return withTenant(svc.tenantId, (s) => {
      const run = getPayrollRun(s, input.runId);
      if (!run) throw new NotFoundError();
      if (run.status !== "approved") throw new ConflictError("Only an approved run can be started");
      if (run.approvedBy !== claims.approverId) throw new ApprovalRejectedError("token was not issued to the run's approver");
      if (run.createdBy === claims.approverId) throw new ConflictError("The person who created a run cannot approve it");

      const content = loadRunContent(s, run, readVerifiedAccounts(reader, s, now));
      if (runContentHash(content) !== claims.contentHash) throw new ContentChangedError();

      redeemTicket(ticket, s, now);

      const rateBp = content.withholdingRateBp;
      const results: TenantInsert<"payResult">[] = [];
      const exceptions: RunOutcome["exceptions"] = [];
      for (const employee of content.employees) {
        if (!employee.bankAccountId) {
          exceptions.push({ employeeId: employee.employeeId, reason: "no_verified_bank_account" });
          continue;
        }
        const pay = computePay(employee.payRateCents, rateBp);
        results.push({
          resultId: randomUUID(),
          runId: run.runId,
          employeeId: employee.employeeId,
          bankAccountId: employee.bankAccountId,
          grossPayCents: pay.grossCents,
          netPayCents: pay.netCents,
        });
      }
      insertPayResults(s, results);
      insertPayExceptions(s, exceptions.map((e) => ({ exceptionId: randomUUID(), runId: run.runId, ...e })));
      if (!markRunComputed(s, run.runId, now)) throw new Error("run left the approved state during computation");

      const late = now.toISOString().slice(0, 10) > run.scheduledRunDate;
      if (late) log.warn("engine.run_started_late", { tenantId: svc.tenantId, runId: run.runId, scheduledRunDate: run.scheduledRunDate, payDate: run.payDate });
      return {
        runId: run.runId,
        status: "computed",
        employeesPaid: results.length,
        totalGrossCents: results.reduce((sum, r) => sum + r.grossPayCents, 0),
        totalNetCents: results.reduce((sum, r) => sum + r.netPayCents, 0),
        exceptions,
        late,
      };
    });
  } catch (err) {
    const contentChanged = err instanceof ContentChangedError;
    const expected = err instanceof ApprovalRejectedError || err instanceof ConflictError || err instanceof NotFoundError || err instanceof ServiceAuthError;
    if (!contentChanged && expected) throw err;
    if (!contentChanged) log.error("engine.computation_failed", { tenantId: input.tenantId, runId: input.runId, error: err });
    const reason = contentChanged ? "content_changed" : "computation_error";
    withTenant(svc.tenantId, (s) => {
      try {
        redeemTicket(ticket, s, now); // burn the token, so this approval cannot be retried
      } catch {
        // already redeemed or expired: nothing more to burn
      }
      markRunFailed(s, input.runId, reason);
    });
    throw new RunFailedError(reason);
  }
}

// ---------- Reading results: the approver's review, and an employee's own pay statements ----------

export interface ReviewLine {
  employeeId: string;
  name: string;
  grossPayCents: number;
  withholdingCents: number;
  netPayCents: number;
  /** Last 4 digits of the account the run pays (the full number is never read here). */
  accountLast4: string | null;
}

export interface RunReview {
  run: RunView;
  results: ReviewLine[];
  exceptions: { employeeId: string; name: string; reason: string }[];
  totals: { employees: number; grossPayCents: number; withholdingCents: number; netPayCents: number };
}

/** A run with its pay results and exceptions, for the approver. Amounts in cents; accounts as last 4 digits. */
export async function reviewRun(auth: ServiceAuth, input: { tenantId: string; runId: string }, now = new Date()): Promise<RunReview> {
  const svc = await authorizeServiceCall(auth, { endpoint: "engine.reviewRun", tenantId: input.tenantId });
  const reader = await openVerifiedAccountReader(await mintAsEngine("bankAccount.readVerified", svc.tenantId), { tenantId: svc.tenantId }, now);
  return withTenant(svc.tenantId, (s) => {
    const run = getPayrollRun(s, input.runId);
    if (!run) throw new NotFoundError();
    const names = new Map(listEmployees(s).map((e) => [e.employeeId, e.fullName]));
    const rows = listPayResults(s, run.runId);
    const endings = accountEndings(reader, s, rows.map((r) => r.bankAccountId), now);
    const results = rows
      .map((r) => ({
        employeeId: r.employeeId,
        name: names.get(r.employeeId) ?? "",
        grossPayCents: r.grossPayCents,
        withholdingCents: r.grossPayCents - r.netPayCents,
        netPayCents: r.netPayCents,
        accountLast4: endings.get(r.bankAccountId) ?? null,
      }))
      .sort((a, b) => a.name.localeCompare(b.name));
    const exceptions = listPayExceptions(s, run.runId).map((e) => ({ employeeId: e.employeeId, name: names.get(e.employeeId) ?? "", reason: e.reason }));
    const sum = (f: (r: ReviewLine) => number) => results.reduce((total, r) => total + f(r), 0);
    return {
      run: toView(run, now),
      results,
      exceptions,
      totals: { employees: results.length, grossPayCents: sum((r) => r.grossPayCents), withholdingCents: sum((r) => r.withholdingCents), netPayCents: sum((r) => r.netPayCents) },
    };
  });
}

export interface PayStatement {
  resultId: string;
  runId: string;
  payDate: string;
  runStatus: string;
  grossPayCents: number;
  withholdingCents: number;
  netPayCents: number;
  accountLast4: string | null;
}

/**
 * The signed-in employee's own pay statements: results of computed or paid runs only. The employee is found from the
 * session's user id, never from the request, so no id in a URL can select someone else's statements.
 */
function statementsFor(s: TenantScope, employeeUserId: string, reader: VerifiedAccountReader, now: Date): PayStatement[] {
  const employee = findEmployeeByUserId(s, employeeUserId);
  if (!employee) return [];
  const rows = listPayResultsForEmployee(s, employee.employeeId);
  const runs = new Map(getPayrollRuns(s, rows.map((r) => r.runId)).map((r) => [r.runId, r]));
  const endings = accountEndings(reader, s, rows.map((r) => r.bankAccountId), now);
  return rows
    .filter((r) => ["computed", "disbursed"].includes(runs.get(r.runId)?.status ?? ""))
    .map((r) => ({
      resultId: r.resultId,
      runId: r.runId,
      payDate: runs.get(r.runId)!.payDate,
      runStatus: runs.get(r.runId)!.status,
      grossPayCents: r.grossPayCents,
      withholdingCents: r.grossPayCents - r.netPayCents,
      netPayCents: r.netPayCents,
      accountLast4: endings.get(r.bankAccountId) ?? null,
    }))
    .sort((a, b) => b.payDate.localeCompare(a.payDate));
}

export async function listPayStatements(auth: ServiceAuth, input: { tenantId: string; employeeUserId: string }, now = new Date()): Promise<PayStatement[]> {
  const svc = await authorizeServiceCall(auth, { endpoint: "engine.payStatements", tenantId: input.tenantId });
  const reader = await openVerifiedAccountReader(await mintAsEngine("bankAccount.readVerified", svc.tenantId), { tenantId: svc.tenantId }, now);
  return withTenant(svc.tenantId, (s) => statementsFor(s, input.employeeUserId, reader, now));
}

/** One of the employee's own statements. Another employee's result id is "not found", exactly like a missing one. */
export async function getPayStatement(auth: ServiceAuth, input: { tenantId: string; employeeUserId: string; resultId: string }, now = new Date()): Promise<PayStatement> {
  const svc = await authorizeServiceCall(auth, { endpoint: "engine.payStatements", tenantId: input.tenantId });
  const reader = await openVerifiedAccountReader(await mintAsEngine("bankAccount.readVerified", svc.tenantId), { tenantId: svc.tenantId }, now);
  const statement = withTenant(svc.tenantId, (s) => {
    const result = getPayResult(s, input.resultId);
    const employee = findEmployeeByUserId(s, input.employeeUserId);
    if (!result || !employee || result.employeeId !== employee.employeeId) return undefined;
    return statementsFor(s, input.employeeUserId, reader, now).find((st) => st.resultId === input.resultId);
  });
  if (!statement) throw new NotFoundError();
  return statement;
}
