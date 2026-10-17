import "server-only";
import { and, eq, isNull } from "drizzle-orm";
import type { TenantInsert, TenantScope } from "@/data/db/tenant-scope";
import { vApprovalToken } from "@/data/db/views";

// Payroll Approval repository (Section 3.2): approval tokens.

export function insertApprovalToken(s: TenantScope, values: TenantInsert<"approvalToken">) {
  s.insert("approvalToken", values);
}

export function findApprovalToken(s: TenantScope, tokenId: string) {
  return s.read(vApprovalToken).where(eq(vApprovalToken.tokenId, tokenId)).get();
}

/**
 * Marks a token redeemed in one atomic UPDATE. Returns true only for the first redemption; a replay finds
 * redeemed_at already set and changes nothing (D10: this replaces the separate replay cache).
 */
export function redeemApprovalToken(s: TenantScope, tokenId: string, now: Date): boolean {
  const changed = s.update("approvalToken", { redeemedAt: now }, (t) => and(eq(t.tokenId, tokenId), isNull(t.redeemedAt)));
  return changed === 1;
}

export function listTokensForRun(s: TenantScope, runId: string) {
  return s.read(vApprovalToken).where(eq(vApprovalToken.runId, runId)).all();
}

/**
 * Moves a run from draft to approved in one atomic UPDATE (Section 3.2: the run tables are shared by Payroll Approval
 * and Payroll Engine). Returns false if the run was not a draft, so two approvals cannot both make the transition.
 */
export function approveDraftRun(s: TenantScope, runId: string, approverId: string): boolean {
  return s.update("payrollRun", { status: "approved", approvedBy: approverId }, (t) => and(eq(t.runId, runId), eq(t.status, "draft"))) === 1;
}

/** Re-approval after a failed run: failed -> approved, possibly by a different approver; clears the failure reason. */
export function reapproveFailedRun(s: TenantScope, runId: string, approverId: string): boolean {
  return (
    s.update("payrollRun", { status: "approved", approvedBy: approverId, failureReason: null }, (t) => and(eq(t.runId, runId), eq(t.status, "failed"))) === 1
  );
}
