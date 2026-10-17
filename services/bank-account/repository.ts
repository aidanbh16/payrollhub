import "server-only";
import { randomUUID } from "node:crypto";
import { and, eq, inArray, isNull } from "drizzle-orm";
import { decryptField, encryptField, fieldContext } from "@/data/crypto/field-encryption";
import type { TenantInsert, TenantScope } from "@/data/db/tenant-scope";
import { vBankAccount, vBankAccountChange, vVerificationCode } from "@/data/db/views";

// Bank Account repository (Section 3.3): bank accounts, pending changes, and out-of-band verification codes.
// Routing and account numbers are encrypted before they reach the database and decrypted only here.

export interface BankDetails {
  routingNumber: string;
  accountNumber: string;
}

function encryptDetails(s: TenantScope, table: string, rowId: string, details: BankDetails, prefix = "") {
  return {
    routing: encryptField(details.routingNumber, fieldContext(s.tenantId, `${table}.${prefix}routing_number`, rowId)),
    account: encryptField(details.accountNumber, fieldContext(s.tenantId, `${table}.${prefix}account_number`, rowId)),
  };
}

function decryptDetails(s: TenantScope, table: string, rowId: string, routing: Buffer, account: Buffer, prefix = "") {
  return {
    routingNumber: decryptField(routing, fieldContext(s.tenantId, `${table}.${prefix}routing_number`, rowId)),
    accountNumber: decryptField(account, fieldContext(s.tenantId, `${table}.${prefix}account_number`, rowId)),
  };
}

/** Stores an account that is already verified (seed data, or a confirmed change). Returns its id. */
export function insertVerifiedAccount(s: TenantScope, employeeId: string, details: BankDetails, verifiedAt: Date): string {
  const bankAccountId = randomUUID();
  const encrypted = encryptDetails(s, "bank_account", bankAccountId, details);
  s.insert("bankAccount", {
    bankAccountId,
    employeeId,
    routingNumber: encrypted.routing,
    accountNumber: encrypted.account,
    accountLast4: details.accountNumber.slice(-4),
    status: "verified",
    verifiedAt,
  });
  return bankAccountId;
}

/** Only verified accounts are ever returned with their numbers; ACH Disbursement reads nothing else (L2-11). */
export function listVerifiedAccounts(s: TenantScope) {
  return s
    .read(vBankAccount)
    .where(eq(vBankAccount.status, "verified"))
    .all()
    .map((row) => ({
      bankAccountId: row.bankAccountId,
      employeeId: row.employeeId,
      accountLast4: row.accountLast4,
      verifiedAt: row.verifiedAt,
      ...decryptDetails(s, "bank_account", row.bankAccountId, row.routingNumber, row.accountNumber),
    }));
}

export function insertAccountChange(
  s: TenantScope,
  values: Omit<TenantInsert<"bankAccountChange">, "changeId" | "newRoutingNumber" | "newAccountNumber">,
  details: BankDetails,
): string {
  const changeId = randomUUID();
  const encrypted = encryptDetails(s, "bank_account_change", changeId, details, "new_");
  s.insert("bankAccountChange", { ...values, changeId, newRoutingNumber: encrypted.routing, newAccountNumber: encrypted.account });
  return changeId;
}

export function getAccountChange(s: TenantScope, changeId: string) {
  const row = s.read(vBankAccountChange).where(eq(vBankAccountChange.changeId, changeId)).get();
  if (!row) return undefined;
  const { newRoutingNumber, newAccountNumber, ...rest } = row;
  return { ...rest, ...decryptDetails(s, "bank_account_change", changeId, newRoutingNumber, newAccountNumber, "new_") };
}

export function insertVerificationCode(s: TenantScope, values: TenantInsert<"verificationCode">) {
  s.insert("verificationCode", values);
}

export function findOpenVerificationCode(s: TenantScope, changeId: string) {
  return s
    .read(vVerificationCode)
    .where(and(eq(vVerificationCode.changeId, changeId), isNull(vVerificationCode.consumedAt)))
    .get();
}

/** Verified accounts without their numbers: ids, owners, and dates only. Nothing is decrypted. */
export function listVerifiedAccountRefs(s: TenantScope) {
  return s
    .read(vBankAccount)
    .where(eq(vBankAccount.status, "verified"))
    .all()
    .map((row) => ({ bankAccountId: row.bankAccountId, employeeId: row.employeeId, accountLast4: row.accountLast4, verifiedAt: row.verifiedAt }));
}

export function findPendingChange(s: TenantScope, employeeId: string) {
  return s.read(vBankAccountChange).where(and(eq(vBankAccountChange.employeeId, employeeId), eq(vBankAccountChange.status, "pending"))).get();
}

/** Marks an employee's pending change superseded and kills its confirmation links. Returns the superseded ids. */
export function supersedePendingChanges(s: TenantScope, employeeId: string, byUserId: string, now: Date): string[] {
  const pending = s
    .read(vBankAccountChange)
    .where(and(eq(vBankAccountChange.employeeId, employeeId), eq(vBankAccountChange.status, "pending")))
    .all()
    .map((c) => c.changeId);
  for (const changeId of pending) {
    s.update("verificationCode", { consumedAt: now }, (t) => and(eq(t.changeId, changeId), isNull(t.consumedAt)));
    s.update("bankAccountChange", { status: "rejected", resolution: "superseded", resolvedAt: now, resolvedBy: byUserId }, (t) =>
      and(eq(t.changeId, changeId), eq(t.status, "pending")),
    );
  }
  return pending;
}

export function findVerificationCodeByHash(s: TenantScope, codeHash: string) {
  return s.read(vVerificationCode).where(eq(vVerificationCode.codeHash, codeHash)).get();
}

/** Uses a confirmation code once, atomically. False if it was already used. */
export function consumeVerificationCode(s: TenantScope, codeId: string, now: Date): boolean {
  return s.update("verificationCode", { consumedAt: now }, (t) => and(eq(t.codeId, codeId), isNull(t.consumedAt))) === 1;
}

export function resolveChange(
  s: TenantScope,
  changeId: string,
  outcome: { status: "confirmed" | "rejected"; resolution: "confirmed" | "rejected"; resolvedBy: string; now: Date },
): boolean {
  return (
    s.update("bankAccountChange", { status: outcome.status, resolution: outcome.resolution, resolvedBy: outcome.resolvedBy, resolvedAt: outcome.now }, (t) =>
      and(eq(t.changeId, changeId), eq(t.status, "pending")),
    ) === 1
  );
}

/** Retires every verified account of an employee (they are then never read for payment again). */
export function retireVerifiedAccounts(s: TenantScope, employeeId: string): number {
  return s.update("bankAccount", { status: "retired" }, (t) => and(eq(t.employeeId, employeeId), eq(t.status, "verified")));
}

/** Last 4 digits of the given accounts, whatever their status. The full numbers are not read or decrypted. */
export function listAccountLast4(s: TenantScope, bankAccountIds: string[]) {
  if (bankAccountIds.length === 0) return [];
  return s
    .read(vBankAccount)
    .where(inArray(vBankAccount.bankAccountId, bankAccountIds))
    .all()
    .map((r) => ({ bankAccountId: r.bankAccountId, accountLast4: r.accountLast4 }));
}

export function listPendingChanges(s: TenantScope) {
  return s.read(vBankAccountChange).where(eq(vBankAccountChange.status, "pending")).all();
}
