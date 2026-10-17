import "server-only";
import { randomUUID } from "node:crypto";
import { withTenant, type TenantScope } from "@/data/db/tenant-scope";
import { activeKeyVersions, signJwtVersioned, verifyJwt } from "@/data/keys/kms";
import { openVerifiedAccountReader, readVerifiedAccounts } from "@/services/bank-account/bank-account-service";
import { findLiveRunForPayDate, getPayrollRun } from "@/services/engine/repository";
import { loadRunContent, runContentHash } from "@/services/engine/run-content";
import { ApprovalRejectedError, ConflictError, NotFoundError, StepUpRequiredError } from "@/services/errors";
import { getUser } from "@/services/identity/repository";
import { authorizeServiceCall, type ServiceAuth } from "@/services/identity/service-tokens";
import { consumeStepUpProof, type StepUpProof } from "@/services/identity/step-up";
import { mintAsApproval } from "@/services/approval/mint-as-approval";
import { approveDraftRun, findApprovalToken, insertApprovalToken, listTokensForRun, reapproveFailedRun, redeemApprovalToken } from "./repository";

// Payroll Approval (Assignment 5, Section 2.4; L2-01, L2-18).
// issueApprovalToken: only with a fresh MFA step-up proof; only for a draft run, or a failed run being approved again
//   (or by the same approver re-issuing after an unused token expired or its key was rotated); never by the run's
//   creator (D27). The token is signed by the key store's approval-token key and carries the tenant, run, approver, a
//   unique jti, the key version (kid), a 5-minute expiry, and `rh`: the hash of the run's content at approval (D28).
// Redemption happens only inside Payroll Engine's transaction: prepareRedemption (async) verifies the service token and
//   the approval token and returns a ticket; redeemTicket (sync) checks the record and sets redeemed_at in one atomic
//   UPDATE inside the engine's transaction, so a redeemed token always comes with a computed run (D10).

export const APPROVAL_ISSUER = "payrollhub:approval";
export const APPROVAL_AUDIENCE = "payrollhub:engine";
export const APPROVAL_TOKEN_TTL_SECONDS = 5 * 60;

export interface IssuedApproval {
  approvalToken: string;
  tokenId: string;
  runId: string;
  keyVersion: number;
  expiresAt: string;
}

/**
 * One usable token per run at a time. A token is usable until it is redeemed or expires, or its signing key is rotated
 * out. (A redeemed token on a run that is still approved or failed was burned by a failed run, never by a successful
 * one: success moves the run to computed in the same transaction.)
 */
function assertNoLiveToken(tokens: { redeemedAt: Date | null; expiresAt: Date; keyVersion: number }[], now: Date) {
  const active = activeKeyVersions("approval-token");
  if (tokens.some((t) => !t.redeemedAt && t.expiresAt.getTime() > now.getTime() && active.includes(t.keyVersion))) {
    throw new ConflictError("An approval token for this run is still valid");
  }
}

export async function issueApprovalToken(
  auth: ServiceAuth,
  input: { tenantId: string; runId: string; approverId: string },
  proof: StepUpProof | undefined,
  now = new Date(),
): Promise<IssuedApproval> {
  const svc = await authorizeServiceCall(auth, { endpoint: "approval.issueToken", tenantId: input.tenantId });
  if (!consumeStepUpProof(proof, { userId: input.approverId, tenantId: svc.tenantId }, now)) throw new StepUpRequiredError();
  const reader = await openVerifiedAccountReader(await mintAsApproval("bankAccount.readVerified", svc.tenantId), { tenantId: svc.tenantId }, now);

  const contentHash = withTenant(svc.tenantId, (s) => {
    const approver = getUser(s, input.approverId);
    if (!approver || approver.role !== "approver" || approver.status !== "active") throw new ConflictError("Only a Payroll Approver can approve a run");
    const run = getPayrollRun(s, input.runId);
    if (!run) throw new NotFoundError();
    // D27: separation of duties (a database trigger enforces the same rule).
    if (run.createdBy === input.approverId) throw new ConflictError("The person who created a run cannot approve it");
    if (run.status === "draft") {
      if (!approveDraftRun(s, input.runId, input.approverId)) throw new ConflictError("Only a draft run can be approved");
    } else if (run.status === "failed") {
      if (run.failureReason === "bank_account_changed") {
        throw new ConflictError("This run can no longer be approved: a bank account changed after it was computed. Create a new run.");
      }
      // RT-01: a failed run frees its pay date for a new run (D35); once one exists, the failed run stays failed.
      if (findLiveRunForPayDate(s, run.payDate, run.runId)) throw new ConflictError("Another payroll run is live for this pay date");
      if (!reapproveFailedRun(s, input.runId, input.approverId)) throw new ConflictError("Only a draft or failed run can be approved");
    } else if (run.status !== "approved" || run.approvedBy !== input.approverId) {
      throw new ConflictError("Only a draft or failed run can be approved");
    }
    assertNoLiveToken(listTokensForRun(s, input.runId), now);
    // D28: what this approval covers, as read right now.
    return runContentHash(loadRunContent(s, getPayrollRun(s, input.runId)!, readVerifiedAccounts(reader, s, now)));
  });

  const tokenId = randomUUID();
  const signed = await signJwtVersioned(
    "approval-token",
    { iss: APPROVAL_ISSUER, aud: APPROVAL_AUDIENCE, sub: input.approverId, tid: svc.tenantId, run: input.runId, rh: contentHash, jti: tokenId },
    APPROVAL_TOKEN_TTL_SECONDS,
  );

  withTenant(svc.tenantId, (s) => {
    // Re-check after the async signing step: another approval of the same run may have finished in between.
    assertNoLiveToken(listTokensForRun(s, input.runId), now);
    insertApprovalToken(s, {
      tokenId,
      runId: input.runId,
      issuedTo: input.approverId,
      keyVersion: signed.keyVersion,
      issuedAt: signed.issuedAt,
      expiresAt: signed.expiresAt,
      redeemedAt: null,
    });
  });
  return { approvalToken: signed.token, tokenId, runId: input.runId, keyVersion: signed.keyVersion, expiresAt: signed.expiresAt.toISOString() };
}

/** The verified claims of an approval token. */
export interface ApprovalClaims {
  tokenId: string;
  tenantId: string;
  runId: string;
  approverId: string;
  keyVersion: number;
  contentHash: string;
}

/** Verifies an approval token's signature (pinned EdDSA, active key version for its kid), issuer, audience, and expiry. */
export async function verifyApprovalToken(token: string): Promise<ApprovalClaims> {
  let payload;
  try {
    payload = await verifyJwt("approval-token", token, { issuer: APPROVAL_ISSUER, audience: APPROVAL_AUDIENCE, maxTokenAgeSeconds: APPROVAL_TOKEN_TTL_SECONDS });
  } catch {
    throw new ApprovalRejectedError("bad signature, wrong algorithm, retired key, or expired");
  }
  if (typeof payload.tid !== "string" || typeof payload.run !== "string" || typeof payload.rh !== "string") {
    throw new ApprovalRejectedError("missing claims");
  }
  return {
    tokenId: String(payload.jti),
    tenantId: payload.tid,
    runId: payload.run,
    approverId: String(payload.sub),
    keyVersion: payload.keyVersion,
    contentHash: payload.rh,
  };
}

/** Proof that Payroll Approval checked this token for this run. Only this module can create one. */
export interface RedemptionTicket extends ApprovalClaims {
  readonly preparedAt: Date;
}

const TICKET_TTL_MS = 60_000;
const tickets = new WeakSet<RedemptionTicket>();

/** Step 1 of redemption (async): Payroll Engine's service token, then the approval token and its tenant and run. */
export async function prepareRedemption(
  auth: ServiceAuth,
  input: { tenantId: string; runId: string; approvalToken: string },
  now = new Date(),
): Promise<RedemptionTicket> {
  const svc = await authorizeServiceCall(auth, { endpoint: "approval.redeemToken", tenantId: input.tenantId });
  const claims = await verifyApprovalToken(input.approvalToken);
  if (claims.tenantId !== svc.tenantId) throw new ApprovalRejectedError("token is for another tenant");
  if (claims.runId !== input.runId) throw new ApprovalRejectedError("token is for another run");
  const ticket: RedemptionTicket = Object.freeze({ ...claims, preparedAt: now });
  tickets.add(ticket);
  return ticket;
}

/**
 * Step 2 of redemption (sync, inside the caller's transaction): the token must match its record, be unexpired, and be
 * for the run's approver; then redeemed_at is set in one atomic UPDATE. A second use, or a simultaneous one, fails.
 */
export function redeemTicket(ticket: RedemptionTicket, s: TenantScope, now = new Date()): void {
  if (!tickets.has(ticket) || ticket.tenantId !== s.tenantId || now.getTime() - ticket.preparedAt.getTime() > TICKET_TTL_MS) {
    throw new ApprovalRejectedError("invalid redemption ticket");
  }
  const record = findApprovalToken(s, ticket.tokenId);
  if (!record || record.runId !== ticket.runId || record.issuedTo !== ticket.approverId || record.keyVersion !== ticket.keyVersion) {
    throw new ApprovalRejectedError("token does not match its record");
  }
  if (record.expiresAt.getTime() <= now.getTime()) throw new ApprovalRejectedError("expired");
  const run = getPayrollRun(s, ticket.runId);
  if (!run || run.status !== "approved" || run.approvedBy !== ticket.approverId) throw new ApprovalRejectedError("run is not approved by this approver");
  if (!redeemApprovalToken(s, ticket.tokenId, now)) throw new ApprovalRejectedError("already redeemed");
}
