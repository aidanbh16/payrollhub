import "server-only";
import { createHash } from "node:crypto";
import { withTenant, type TenantScope } from "@/data/db/tenant-scope";
import { signBytes, verifyBytes } from "@/data/keys/kms";
import { log } from "@/data/log/logger";
import { mintAsAch } from "@/services/ach/mint-as-ach";
import { openPayableAccountReader, readPayableAccounts, type PayableAccountReader } from "@/services/bank-account/bank-account-service";
import { getPayrollRun, listEmployees, listPayResults, markComputedRunFailed, markRunDisbursed } from "@/services/engine/repository";
import { BankRejectedError, ConflictError, NotFoundError, RunFailedError } from "@/services/errors";
import { getTenant } from "@/services/identity/repository";
import { authorizeServiceCall, type ServiceAuth } from "@/services/identity/service-tokens";
import { sendBatch } from "./bank-client";
import { buildAchFile, checkControlTotals } from "./nacha";
import { getAchBatchForRun, getAchBatchStatusForRun, insertAchBatch, markBatchRejected, markBatchSent } from "./repository";

// ACH Disbursement (Assignment 5, Sections 2.4 and 2.5; Figure 6). Two stages, each guarding a different threat:
//   build (L2-13): one batch per run. The idempotency key is derived from the tenant and run, and both it and run_id
//     are unique in the database, so a retry or a concurrent submit gets the batch that already exists. Only a
//     computed run produces a batch, built from its pay results and verified accounts, never from the request; the
//     control totals are checked against the pay results on the exact bytes before they are signed (and again by a
//     database trigger when the row is written).
//   sign and send (L1-22): the exact file bytes are signed by the key store's ach-batch key and sent over mTLS to the
//     pinned bank, which verifies the signature against its pinned copy of the public key. A retry resends the same
//     stored bytes; the bank's own duplicate check makes a repeated delivery harmless.
// The file body is encrypted at rest (D15), never logged, and never returned by any function here.

/** The stand-in originating bank (ODFI) that sends PayrollHub's credits. A publicly listed ABA number. */
export const ORIGINATING_BANK = { routingNumber: "011000028", name: "PayrollHub Stand-in Bank" };

export interface BatchStatusView {
  batchId: string;
  runId: string;
  status: string;
  signingKeyVersion: number | null;
  entryCount: number | null;
  totalCreditCents: number | null;
  bankReference: string | null;
  createdAt: string;
  sentAt: string | null;
}

/** Derived from the tenant and run only, so the same run always maps to the same key (and batch ID). */
export function achIdempotencyKey(tenantId: string, runId: string): string {
  return createHash("sha256").update(`payrollhub.ach-batch.v1\n${tenantId}\n${runId}`).digest("hex");
}

/** The batch ID written inside the signed file: 20 characters, derived from the idempotency key. */
export const batchIdFor = (idempotencyKey: string) => `B${idempotencyKey.slice(0, 19).toUpperCase()}`;

type BatchMeta = NonNullable<ReturnType<typeof getAchBatchStatusForRun>>;

function view(b: BatchMeta): BatchStatusView {
  return {
    batchId: b.batchId,
    runId: b.runId,
    status: b.status,
    signingKeyVersion: b.signingKeyVersion,
    entryCount: b.entryCount,
    totalCreditCents: b.totalCreditCents,
    bankReference: b.bankReference,
    createdAt: b.createdAt.toISOString(),
    sentAt: b.sentAt?.toISOString() ?? null,
  };
}

/** Batch metadata for a run. Never includes the file body, which holds full bank numbers. */
export async function getBatchStatus(auth: ServiceAuth, input: { tenantId: string; runId: string }): Promise<BatchStatusView> {
  const svc = await authorizeServiceCall(auth, { endpoint: "ach.getBatch", tenantId: input.tenantId });
  const batch = withTenant(svc.tenantId, (s) => getAchBatchStatusForRun(s, input.runId));
  if (!batch) throw new NotFoundError();
  return view(batch);
}

const isUniqueViolation = (err: unknown): boolean => {
  const codes = [err, (err as { cause?: unknown })?.cause].map((e) => String((e as { code?: unknown })?.code ?? ""));
  return codes.some((c) => c === "SQLITE_CONSTRAINT_UNIQUE" || c === "SQLITE_CONSTRAINT_PRIMARYKEY");
};

type Prepared = { kind: "batch"; batch: BatchMeta } | { kind: "account_changed"; employeeIds: string[] };

/** Stage 1, in one transaction: return the run's batch if it exists; otherwise build, check, sign, and store it. */
function prepareBatch(s: TenantScope, runId: string, reader: PayableAccountReader, now: Date): Prepared {
  const run = getPayrollRun(s, runId);
  if (!run) throw new NotFoundError();
  const existing = getAchBatchStatusForRun(s, runId);
  if (existing) return { kind: "batch", batch: existing };
  if (run.status !== "computed") throw new ConflictError("Only a computed run can be sent to the bank");

  const results = listPayResults(s, runId);
  const accounts = readPayableAccounts(reader, s, results.map((r) => r.bankAccountId), now);
  // D35: an account paid at compute time that is no longer verified (a bank change confirmed since). Not paid, and the
  // run is closed; a new run pays those employees into the accounts they confirmed.
  const changed = results.filter((r) => !accounts.has(r.bankAccountId));
  if (changed.length > 0) {
    markComputedRunFailed(s, runId, "bank_account_changed");
    return { kind: "account_changed", employeeIds: changed.map((r) => r.employeeId) };
  }

  const names = new Map(listEmployees(s).map((e) => [e.employeeId, e.fullName]));
  const tenant = getTenant(s)!;
  const idempotencyKey = achIdempotencyKey(s.tenantId, runId);
  const batchId = batchIdFor(idempotencyKey);
  const paid = results.filter((r) => r.netPayCents > 0).sort((a, b) => (a.employeeId < b.employeeId ? -1 : 1));
  const totalCreditCents = results.reduce((sum, r) => sum + r.netPayCents, 0);
  const file = buildAchFile({
    batchId,
    originatingBank: ORIGINATING_BANK,
    company: { id: `PH${s.tenantId.replace(/-/g, "")}`, name: tenant.name },
    effectiveDate: run.payDate,
    createdAt: now,
    entries: paid.map((r) => {
      const account = accounts.get(r.bankAccountId)!;
      return {
        routingNumber: account.routingNumber,
        accountNumber: account.accountNumber,
        amountCents: r.netPayCents,
        individualId: r.employeeId.replace(/-/g, "").slice(0, 15),
        individualName: names.get(r.employeeId) ?? "",
      };
    }),
  });
  checkControlTotals(file, { batchId, entryCount: paid.length, totalCreditCents });
  const { signature, keyVersion } = signBytes("ach-batch", Buffer.from(file, "utf8"));
  try {
    insertAchBatch(
      s,
      {
        batchId,
        runId,
        idempotencyKey,
        signature,
        signingKeyVersion: keyVersion,
        status: "signed",
        createdAt: now,
        sentAt: null,
        entryCount: paid.length,
        totalCreditCents,
        bankReference: null,
        rejectionReason: null,
      },
      file,
    );
  } catch (err) {
    // Backstop: another writer stored this run's batch first (UNIQUE run_id / idempotency_key). Return that one.
    const winner = isUniqueViolation(err) ? getAchBatchStatusForRun(s, runId) : undefined;
    if (winner) return { kind: "batch", batch: winner };
    throw err;
  }
  log.info("ach.batch_signed", { tenantId: s.tenantId, runId, batchId, entryCount: paid.length, totalCreditCents, keyVersion });
  return { kind: "batch", batch: getAchBatchStatusForRun(s, runId)! };
}

/** Stage 2: verify the stored signature on the stored bytes, send them, and record the bank's answer. */
async function deliver(tenantId: string, runId: string, now: Date): Promise<BatchMeta> {
  const stored = withTenant(tenantId, (s) => getAchBatchForRun(s, runId))!;
  const bytes = Buffer.from(stored.fileBody, "utf8");
  if (!stored.signature || stored.signingKeyVersion === null || !verifyBytes("ach-batch", bytes, stored.signature, stored.signingKeyVersion)) {
    log.error("ach.stored_batch_invalid", { tenantId, runId, batchId: stored.batchId });
    throw new Error("Stored ACH batch failed its signature check");
  }
  const answer = await sendBatch({ bytes, signature: stored.signature, keyVersion: stored.signingKeyVersion });
  const delivered = answer.status === "accepted" || (answer.status === "duplicate" && answer.sameFile);
  const result = withTenant(tenantId, (s) => {
    if (delivered) {
      markBatchSent(s, stored.batchId, answer.bankReference, now);
      markRunDisbursed(s, runId);
    } else {
      markBatchRejected(s, stored.batchId, answer.status === "rejected" ? answer.reason : "duplicate batch id with different contents");
    }
    return getAchBatchStatusForRun(s, runId)!;
  });
  if (!delivered) {
    const reason = answer.status === "rejected" ? answer.reason : "duplicate batch id with different contents";
    log.warn("ach.batch_rejected_by_bank", { tenantId, runId, batchId: stored.batchId, reason });
    throw new BankRejectedError(reason);
  }
  log.info("ach.batch_sent", { tenantId, runId, batchId: stored.batchId, bankReference: result.bankReference, duplicateDelivery: answer.status === "duplicate" });
  return result;
}

/**
 * Sends a computed run's pay to the bank. Idempotent: whatever happens (retry after a timeout, a double click, two
 * concurrent requests), a run has at most one batch, and the bank accepts it at most once.
 */
export async function disburseRun(auth: ServiceAuth, input: { tenantId: string; runId: string }, now = new Date()): Promise<BatchStatusView> {
  const svc = await authorizeServiceCall(auth, { endpoint: "ach.disburse", tenantId: input.tenantId });
  const reader = await openPayableAccountReader(await mintAsAch("bankAccount.readPayable", svc.tenantId), { tenantId: svc.tenantId }, now);
  const prepared = withTenant(svc.tenantId, (s) => prepareBatch(s, input.runId, reader, now));
  if (prepared.kind === "account_changed") {
    log.warn("ach.bank_account_changed_after_compute", { tenantId: svc.tenantId, runId: input.runId, employeeIds: prepared.employeeIds });
    throw new RunFailedError("bank_account_changed");
  }
  if (prepared.batch.status === "sent") return view(prepared.batch);
  return view(await deliver(svc.tenantId, input.runId, now));
}
