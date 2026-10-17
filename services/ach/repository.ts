import "server-only";
import { and, eq, inArray } from "drizzle-orm";
import { decryptField, encryptField, fieldContext } from "@/data/crypto/field-encryption";
import type { TenantInsert, TenantScope } from "@/data/db/tenant-scope";
import { vAchBatch } from "@/data/db/views";

// ACH Disbursement repository (Section 3.3): ACH batches. The file body holds full account and routing numbers,
// so it is encrypted at rest like the bank account columns (D15). Only getAchBatchForRun decrypts it, and only
// ACH Disbursement's send step calls that; everything else reads metadata.

export function insertAchBatch(
  s: TenantScope,
  values: Omit<TenantInsert<"achBatch">, "fileBody">,
  fileBody: string,
) {
  s.insert("achBatch", {
    ...values,
    fileBody: encryptField(fileBody, fieldContext(s.tenantId, "ach_batch.file_body", values.batchId)),
  });
}

/** The full batch, file body decrypted. For signing checks and sending only: never returned, never logged. */
export function getAchBatchForRun(s: TenantScope, runId: string) {
  const row = s.read(vAchBatch).where(eq(vAchBatch.runId, runId)).get();
  if (!row) return undefined;
  const { fileBody, ...rest } = row;
  return { ...rest, fileBody: decryptField(fileBody, fieldContext(s.tenantId, "ach_batch.file_body", row.batchId)) };
}

/** Batch metadata only: the encrypted file body is not read or decrypted. */
export function getAchBatchStatusForRun(s: TenantScope, runId: string) {
  const row = s.read(vAchBatch).where(eq(vAchBatch.runId, runId)).get();
  if (!row) return undefined;
  return {
    batchId: row.batchId,
    runId: row.runId,
    idempotencyKey: row.idempotencyKey,
    status: row.status,
    signingKeyVersion: row.signingKeyVersion,
    entryCount: row.entryCount,
    totalCreditCents: row.totalCreditCents,
    bankReference: row.bankReference,
    rejectionReason: row.rejectionReason,
    createdAt: row.createdAt,
    sentAt: row.sentAt,
  };
}

/** signed | rejected -> sent, recording the bank's reference. False if it was already sent. */
export function markBatchSent(s: TenantScope, batchId: string, bankReference: string, now: Date): boolean {
  return (
    s.update("achBatch", { status: "sent", bankReference, sentAt: now, rejectionReason: null }, (t) =>
      and(eq(t.batchId, batchId), inArray(t.status, ["signed", "rejected"])),
    ) === 1
  );
}

/** signed -> rejected, with the bank's reason. The same signed bytes may be sent again later. */
export function markBatchRejected(s: TenantScope, batchId: string, reason: string): boolean {
  return s.update("achBatch", { status: "rejected", rejectionReason: reason }, (t) => and(eq(t.batchId, batchId), inArray(t.status, ["signed", "rejected"]))) === 1;
}
