import "server-only";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { env } from "@/config/env";
import { withTenant, type TenantScope } from "@/data/db/tenant-scope";
import { findEmployeeByUserId, getEmployee, listEmployees } from "@/services/engine/repository";
import { InvalidInputError, NotFoundError, ServiceAuthError } from "@/services/errors";
import { getUser, listUsers } from "@/services/identity/repository";
import { authorizeServiceCall, type ServiceAuth } from "@/services/identity/service-tokens";
import { noticeRequested, noticeResolved } from "./notify";
import {
  consumeVerificationCode, findPendingChange, findVerificationCodeByHash, getAccountChange, insertAccountChange, insertVerificationCode,
  insertVerifiedAccount, listAccountLast4, listPendingChanges, listVerifiedAccountRefs, listVerifiedAccounts, resolveChange, retireVerifiedAccounts,
  supersedePendingChanges,
} from "./repository";
import { isValidAccountNumber, isValidRoutingNumber, last4 } from "./validation";

// Bank Account service (Assignment 5, Sections 2.1, 2.4, 3.3; L2-11). It owns every employee's bank account record and
// is the only source of accounts for payroll, which sees verified accounts only. A change, whether the employee asks
// for it in the portal or an HR Admin enters it, is stored as PENDING and never paid until the employee confirms it
// through a separate channel: a single-use link sent to their existing contact address (D13).
//
// Reading verified accounts is split in two so Payroll Engine can use it inside its own synchronous transaction:
//   openVerifiedAccountReader (async) checks the caller's service token and returns a reader;
//   readVerifiedAccounts (sync) uses that reader inside the caller's tenant scope.
// Only this module can create a reader, and each one works for one tenant for 60 seconds.

export interface VerifiedAccountReader {
  readonly tenantId: string;
  readonly openedAt: Date;
}

export interface VerifiedAccountRef {
  bankAccountId: string;
  employeeId: string;
  accountLast4: string;
}

const READER_TTL_MS = 60_000;
const readers = new WeakSet<VerifiedAccountReader>();

export async function openVerifiedAccountReader(auth: ServiceAuth, input: { tenantId: string }, now = new Date()): Promise<VerifiedAccountReader> {
  const svc = await authorizeServiceCall(auth, { endpoint: "bankAccount.readVerified", tenantId: input.tenantId });
  const reader = Object.freeze({ tenantId: svc.tenantId, openedAt: now });
  readers.add(reader);
  return reader;
}

/** The verified account each employee is paid into: the most recently verified one. Numbers are not included. */
export function readVerifiedAccounts(reader: VerifiedAccountReader, s: TenantScope, now = new Date()): VerifiedAccountRef[] {
  if (!readers.has(reader) || reader.tenantId !== s.tenantId || now.getTime() - reader.openedAt.getTime() > READER_TTL_MS) {
    throw new ServiceAuthError("invalid bank account reader");
  }
  const latest = new Map<string, { bankAccountId: string; employeeId: string; accountLast4: string; verifiedAt: Date }>();
  for (const account of listVerifiedAccountRefs(s)) {
    const current = latest.get(account.employeeId);
    if (!current || account.verifiedAt.getTime() > current.verifiedAt.getTime()) latest.set(account.employeeId, account);
  }
  return [...latest.values()].map(({ bankAccountId, employeeId, accountLast4 }) => ({ bankAccountId, employeeId, accountLast4 }));
}

/** Last 4 digits of the given accounts, whatever their status (statements show where pay went). No numbers. */
export function accountEndings(reader: VerifiedAccountReader, s: TenantScope, bankAccountIds: string[], now = new Date()): Map<string, string> {
  if (!readers.has(reader) || reader.tenantId !== s.tenantId || now.getTime() - reader.openedAt.getTime() > READER_TTL_MS) {
    throw new ServiceAuthError("invalid bank account reader");
  }
  return new Map(listAccountLast4(s, bankAccountIds).map((a) => [a.bankAccountId, a.accountLast4]));
}

export interface EmployeeAccountView {
  employeeId: string;
  fullName: string;
  email: string;
  status: string;
  account: { accountLast4: string; verifiedAt: string } | null;
  /** A requested change not yet confirmed by the employee: unverified, never paid. */
  pending: { changeId: string; accountLast4: string; requestedAt: string; requestedBy: "employee" | "hr_admin" } | null;
}

/** The HR Admin's view of employees' pay accounts: last 4 digits only, and pending changes shown as unverified. */
export async function listEmployeeAccounts(auth: ServiceAuth, input: { tenantId: string }): Promise<EmployeeAccountView[]> {
  const svc = await authorizeServiceCall(auth, { endpoint: "bankAccount.adminList", tenantId: input.tenantId });
  return withTenant(svc.tenantId, (s) => {
    const emails = new Map(listUsers(s).map((u) => [u.userId, u.email]));
    const verified = new Map<string, { accountLast4: string; verifiedAt: Date }>();
    for (const a of listVerifiedAccountRefs(s)) {
      const current = verified.get(a.employeeId);
      if (!current || a.verifiedAt > current.verifiedAt) verified.set(a.employeeId, a);
    }
    const pending = new Map(listPendingChanges(s).map((c) => [c.employeeId, c]));
    return listEmployees(s)
      .map((e) => {
        const v = verified.get(e.employeeId);
        const p = pending.get(e.employeeId);
        return {
          employeeId: e.employeeId,
          fullName: e.fullName,
          email: emails.get(e.userId) ?? "",
          status: e.status,
          account: v ? { accountLast4: v.accountLast4, verifiedAt: v.verifiedAt.toISOString() } : null,
          pending: p
            ? {
                changeId: p.changeId,
                accountLast4: last4(getAccountChange(s, p.changeId)!.accountNumber),
                requestedAt: p.requestedAt.toISOString(),
                requestedBy: p.requestedBy === e.userId ? ("employee" as const) : ("hr_admin" as const),
              }
            : null,
        };
      })
      .sort((a, b) => a.fullName.localeCompare(b.fullName));
  });
}

// ---------- Payable accounts: full numbers, for ACH Disbursement only ----------

export interface PayableAccountReader {
  readonly tenantId: string;
  readonly openedAt: Date;
}

export interface PayableAccount {
  bankAccountId: string;
  employeeId: string;
  routingNumber: string;
  accountNumber: string;
}

const payableReaders = new WeakSet<PayableAccountReader>();

/** ACH Disbursement's read of account numbers. Its own endpoint (bankAccount.readPayable), granted to "ach" alone. */
export async function openPayableAccountReader(auth: ServiceAuth, input: { tenantId: string }, now = new Date()): Promise<PayableAccountReader> {
  const svc = await authorizeServiceCall(auth, { endpoint: "bankAccount.readPayable", tenantId: input.tenantId });
  const reader = Object.freeze({ tenantId: svc.tenantId, openedAt: now });
  payableReaders.add(reader);
  return reader;
}

/**
 * The requested accounts that are verified RIGHT NOW, with their numbers. An account that was retired since (a bank
 * change confirmed) is simply absent: the ACH-facing read stays verified-only (L2-11), and the caller decides (D35).
 */
export function readPayableAccounts(reader: PayableAccountReader, s: TenantScope, bankAccountIds: string[], now = new Date()): Map<string, PayableAccount> {
  if (!payableReaders.has(reader) || reader.tenantId !== s.tenantId || now.getTime() - reader.openedAt.getTime() > READER_TTL_MS) {
    throw new ServiceAuthError("invalid bank account reader");
  }
  const wanted = new Set(bankAccountIds);
  const out = new Map<string, PayableAccount>();
  for (const a of listVerifiedAccounts(s)) {
    if (wanted.has(a.bankAccountId)) out.set(a.bankAccountId, { bankAccountId: a.bankAccountId, employeeId: a.employeeId, routingNumber: a.routingNumber, accountNumber: a.accountNumber });
  }
  return out;
}

// ---------- Pending changes and out-of-band confirmation ----------

/** How long a confirmation link works. */
export const LINK_TTL_MS = 60 * 60_000;

export interface ChangeReceipt {
  changeId: string;
  status: "pending";
  accountLast4: string;
  expiresAt: string;
}

export interface ChangeView {
  changeId: string;
  accountLast4: string;
  requestedAt: string;
  requestedBy: "you" | "your HR administrator";
  expiresAt: string;
}

// Links carry 256 random bits; only their SHA-256 is stored (in verification_code), so the database never holds a link.
const linkHash = (token: string) => createHash("sha256").update(token).digest("hex");

/**
 * Records a requested change as PENDING; it is never paid until the employee confirms it from their own email.
 * Any earlier pending change is superseded in the same transaction (its link stops working). Returns no link or token:
 * those go only to the employee's existing contact address. Works the same for an employee and an HR Admin.
 */
export async function requestBankChange(
  auth: ServiceAuth,
  input: { tenantId: string; employeeId: string; requestedBy: string; routingNumber: string; accountNumber: string },
  now = new Date(),
): Promise<ChangeReceipt> {
  const svc = await authorizeServiceCall(auth, { endpoint: "bankAccount.requestChange", tenantId: input.tenantId });
  if (!isValidRoutingNumber(input.routingNumber)) throw new InvalidInputError("Routing number is not a valid ABA routing number");
  if (!isValidAccountNumber(input.accountNumber)) throw new InvalidInputError("Account number must be 4 to 17 digits");

  const token = randomBytes(32).toString("base64url");
  const expiresAt = new Date(now.getTime() + LINK_TTL_MS);
  const result = withTenant(svc.tenantId, (s) => {
    const employee = getEmployee(s, input.employeeId);
    if (!employee || employee.status !== "active") throw new NotFoundError();
    const requester = getUser(s, input.requestedBy);
    const isSelf = requester?.userId === employee.userId;
    if (!requester || requester.status !== "active" || !(isSelf || requester.role === "hr_admin")) throw new NotFoundError();
    const contact = getUser(s, employee.userId)!.email;

    const superseded = supersedePendingChanges(s, employee.employeeId, requester.userId, now);
    const supersededLast4 = superseded.map((id) => last4(getAccountChange(s, id)!.accountNumber));
    const changeId = insertAccountChange(
      s,
      { employeeId: employee.employeeId, requestedBy: requester.userId, status: "pending", requestedAt: now, resolvedAt: null, resolution: null, resolvedBy: null },
      { routingNumber: input.routingNumber, accountNumber: input.accountNumber },
    );
    insertVerificationCode(s, { codeId: randomUUID(), changeId, codeHash: linkHash(token), attempts: 0, expiresAt, consumedAt: null });
    return { changeId, contact, isSelf, supersededLast4 };
  });

  for (const old of result.supersededLast4) noticeResolved(result.contact, { last4: old, outcome: "superseded", at: now });
  const link = new URL(`/employee/bank-change/${result.changeId}`, env().APP_ORIGIN);
  link.searchParams.set("token", token);
  noticeRequested(result.contact, {
    last4: last4(input.accountNumber),
    requestedBy: result.isSelf ? "you" : "your HR administrator",
    at: now,
    link: link.toString(),
    expiresAt,
  });
  return { changeId: result.changeId, status: "pending", accountLast4: last4(input.accountNumber), expiresAt: expiresAt.toISOString() };
}

/**
 * The change a confirmation link points to, if the link is valid: right hash, same change, unused, unexpired, change
 * still pending, and the signed-in employee is the one the change is for. Anything else is "not found", so a link
 * reveals nothing about other tenants, employees, or changes.
 */
function linkTarget(s: TenantScope, input: { employeeUserId: string; changeId: string; token: string }, now: Date) {
  const code = findVerificationCodeByHash(s, linkHash(input.token));
  if (!code || code.changeId !== input.changeId || code.consumedAt || code.expiresAt.getTime() <= now.getTime()) throw new NotFoundError();
  const change = getAccountChange(s, input.changeId);
  if (!change || change.status !== "pending") throw new NotFoundError();
  const employee = getEmployee(s, change.employeeId);
  if (!employee || employee.userId !== input.employeeUserId) throw new NotFoundError();
  return { code, change, employee };
}

/** GET of a confirmation link: shows the change (last 4 digits only) and changes nothing. */
export async function viewBankChange(
  auth: ServiceAuth,
  input: { tenantId: string; employeeUserId: string; changeId: string; token: string },
  now = new Date(),
): Promise<ChangeView> {
  const svc = await authorizeServiceCall(auth, { endpoint: "bankAccount.viewChange", tenantId: input.tenantId });
  return withTenant(svc.tenantId, (s) => {
    const { code, change, employee } = linkTarget(s, input, now);
    return {
      changeId: change.changeId,
      accountLast4: last4(change.accountNumber),
      requestedAt: change.requestedAt.toISOString(),
      requestedBy: change.requestedBy === employee.userId ? "you" : "your HR administrator",
      expiresAt: code.expiresAt.toISOString(),
    };
  });
}

/**
 * POST from the link page, by the signed-in employee. Confirm: the new account becomes verified and every previously
 * verified account is retired, in one transaction, with who and when recorded. Reject: the change is closed unpaid.
 * The code is consumed atomically, so a link works once.
 */
export async function resolveBankChange(
  auth: ServiceAuth,
  input: { tenantId: string; employeeUserId: string; changeId: string; token: string; decision: "confirm" | "reject" },
  now = new Date(),
): Promise<{ changeId: string; status: "confirmed" | "rejected"; accountLast4: string }> {
  const svc = await authorizeServiceCall(auth, { endpoint: "bankAccount.resolveChange", tenantId: input.tenantId });
  const result = withTenant(svc.tenantId, (s) => {
    const { code, change, employee } = linkTarget(s, input, now);
    if (!consumeVerificationCode(s, code.codeId, now)) throw new NotFoundError();
    const confirm = input.decision === "confirm";
    if (confirm) {
      retireVerifiedAccounts(s, employee.employeeId);
      insertVerifiedAccount(s, employee.employeeId, { routingNumber: change.routingNumber, accountNumber: change.accountNumber }, now);
    }
    const status: "confirmed" | "rejected" = confirm ? "confirmed" : "rejected";
    if (!resolveChange(s, change.changeId, { status, resolution: status, resolvedBy: input.employeeUserId, now })) throw new NotFoundError();
    return { status, last4: last4(change.accountNumber), contact: getUser(s, employee.userId)!.email };
  });
  noticeResolved(result.contact, { last4: result.last4, outcome: result.status, at: now });
  return { changeId: input.changeId, status: result.status, accountLast4: result.last4 };
}

/** The signed-in employee's own pay account and pending change, last 4 digits only. */
export async function getBankSummary(auth: ServiceAuth, input: { tenantId: string; employeeUserId: string }) {
  const svc = await authorizeServiceCall(auth, { endpoint: "bankAccount.summary", tenantId: input.tenantId });
  return withTenant(svc.tenantId, (s) => {
    const employee = findEmployeeByUserId(s, input.employeeUserId);
    if (!employee) throw new NotFoundError();
    const current = listVerifiedAccountRefs(s)
      .filter((a) => a.employeeId === employee.employeeId)
      .sort((a, b) => b.verifiedAt.getTime() - a.verifiedAt.getTime())[0];
    const pending = findPendingChange(s, employee.employeeId);
    return {
      employeeId: employee.employeeId,
      current: current ? { accountLast4: current.accountLast4, verifiedAt: current.verifiedAt.toISOString() } : null,
      pending: pending
        ? { changeId: pending.changeId, accountLast4: last4(getAccountChange(s, pending.changeId)!.accountNumber), requestedAt: pending.requestedAt.toISOString() }
        : null,
    };
  });
}
