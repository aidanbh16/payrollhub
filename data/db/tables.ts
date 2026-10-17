import { sql } from "drizzle-orm";
import { blob, check, foreignKey, integer, primaryKey, sqliteTable, text, unique } from "drizzle-orm/sqlite-core";

// Payroll DB schema (Assignment 5, Section 3). Base tables live here; application code never imports this
// module. Reads go through the tenant-filtered views in views.ts, writes through the scoped repository.
//
// Column sets are factories so each base table and its matching view are built from the same definition.
// Types: tenant ids are short slugs ("acme"), other ids are UUIDs, timestamps are epoch milliseconds,
// dates are ISO strings, money is integer cents, and encrypted fields are AES-256-GCM blobs.
// The sql tag here only defines CHECK constraints, which drizzle-kit compiles into migrations/.

const ts = (name: string) => integer(name, { mode: "timestamp_ms" });

// ---------- 3.1 Identity & tenancy ----------

export const tenantColumns = () => ({
  tenantId: text("tenant_id").notNull(),
  name: text("name").notNull(),
  status: text("status", { enum: ["active", "suspended"] }).notNull(),
  // D16 addition: flat withholding rate per tenant, in basis points (2200 = 22%).
  withholdingRateBp: integer("withholding_rate_bp").notNull(),
  createdAt: ts("created_at").notNull(),
});
export const tenant = sqliteTable("tenant", tenantColumns(), (t) => [
  primaryKey({ columns: [t.tenantId] }),
  check("tenant_status_check", sql`${t.status} IN ('active', 'suspended')`),
  check("tenant_withholding_check", sql`${t.withholdingRateBp} BETWEEN 0 AND 10000`),
]);

export const appUserColumns = () => ({
  userId: text("user_id").notNull(),
  tenantId: text("tenant_id").notNull(),
  email: text("email").notNull(),
  role: text("role", { enum: ["hr_admin", "approver", "employee"] }).notNull(),
  mfaEnrolled: integer("mfa_enrolled", { mode: "boolean" }).notNull(),
  ssoSubject: text("sso_subject"),
  status: text("status", { enum: ["active", "disabled"] }).notNull(),
  // D15 additions. Employees sign in through their tenant's SSO IdP, so they never have a password here.
  passwordHash: text("password_hash"),
  totpSecret: blob("totp_secret", { mode: "buffer" }),
  // Last TOTP time step accepted for this user; a code from the same or an earlier step is rejected as a replay.
  totpLastUsedStep: integer("totp_last_used_step"),
});
export const appUser = sqliteTable("app_user", appUserColumns(), (t) => [
  primaryKey({ columns: [t.userId] }),
  unique("app_user_tenant_key").on(t.tenantId, t.userId),
  unique("app_user_tenant_email").on(t.tenantId, t.email),
  unique("app_user_tenant_sso_subject").on(t.tenantId, t.ssoSubject),
  foreignKey({ name: "app_user_tenant_fk", columns: [t.tenantId], foreignColumns: [tenant.tenantId] }),
  check("app_user_role_check", sql`${t.role} IN ('hr_admin', 'approver', 'employee')`),
  check("app_user_status_check", sql`${t.status} IN ('active', 'disabled')`),
  check(
    "app_user_password_check",
    sql`(${t.role} = 'employee' AND ${t.passwordHash} IS NULL) OR (${t.role} <> 'employee' AND ${t.passwordHash} IS NOT NULL)`,
  ),
  // L0-01: HR Admin and Payroll Approver accounts must be MFA-enrolled.
  check("app_user_mfa_check", sql`${t.role} = 'employee' OR (${t.mfaEnrolled} = 1 AND ${t.totpSecret} IS NOT NULL)`),
]);

export const sessionColumns = () => ({
  sessionId: text("session_id").notNull(),
  tenantId: text("tenant_id").notNull(),
  userId: text("user_id").notNull(),
  deviceBinding: text("device_binding").notNull(),
  mfaVerifiedAt: ts("mfa_verified_at"),
  expiresAt: ts("expires_at").notNull(),
  revokedAt: ts("revoked_at"),
});
export const session = sqliteTable("session", sessionColumns(), (t) => [
  primaryKey({ columns: [t.sessionId] }),
  foreignKey({ name: "session_user_fk", columns: [t.tenantId, t.userId], foreignColumns: [appUser.tenantId, appUser.userId] }),
]);

export const tenantIdpConfigColumns = () => ({
  idpConfigId: text("idp_config_id").notNull(),
  tenantId: text("tenant_id").notNull(),
  issuer: text("issuer").notNull(),
  audience: text("audience").notNull(),
  // D11: holds the stand-in IdP's public key (PEM) rather than an X.509 certificate.
  signingCert: text("signing_cert").notNull(),
  certExpiresAt: ts("cert_expires_at").notNull(),
});
export const tenantIdpConfig = sqliteTable("tenant_idp_config", tenantIdpConfigColumns(), (t) => [
  primaryKey({ columns: [t.idpConfigId] }),
  unique("tenant_idp_config_tenant").on(t.tenantId),
  foreignKey({ name: "tenant_idp_config_tenant_fk", columns: [t.tenantId], foreignColumns: [tenant.tenantId] }),
]);

// Addition (Turn 5): SSO assertion ids already used to sign in, kept until the assertion expires, so a captured
// assertion cannot be replayed (L1-20; same single-use pattern as approval tokens, L2-01).
export const ssoAssertionColumns = () => ({
  tenantId: text("tenant_id").notNull(),
  assertionId: text("assertion_id").notNull(),
  expiresAt: ts("expires_at").notNull(),
});
export const ssoAssertion = sqliteTable("sso_assertion", ssoAssertionColumns(), (t) => [
  primaryKey({ columns: [t.tenantId, t.assertionId] }),
  foreignKey({ name: "sso_assertion_tenant_fk", columns: [t.tenantId], foreignColumns: [tenant.tenantId] }),
]);

// Addition (Turn 6): ids of single-use service tokens already presented, kept until the token expires, so a token
// for an internal money route (Payroll Engine run, ACH) cannot be replayed (L1-19).
export const serviceTokenUseColumns = () => ({
  tenantId: text("tenant_id").notNull(),
  tokenId: text("token_id").notNull(),
  expiresAt: ts("expires_at").notNull(),
});
export const serviceTokenUse = sqliteTable("service_token_use", serviceTokenUseColumns(), (t) => [
  primaryKey({ columns: [t.tenantId, t.tokenId] }),
  foreignKey({ name: "service_token_use_tenant_fk", columns: [t.tenantId], foreignColumns: [tenant.tenantId] }),
]);

// Platform-level: no tenant_id. Readable and writable only inside a platform scope (Identity & Access).
export const serviceGrantColumns = () => ({
  grantId: text("grant_id").notNull(),
  callingService: text("calling_service").notNull(),
  targetEndpoint: text("target_endpoint").notNull(),
  scope: text("scope").notNull(),
  createdAt: ts("created_at").notNull(),
});
export const serviceGrant = sqliteTable("service_grant", serviceGrantColumns(), (t) => [
  primaryKey({ columns: [t.grantId] }),
  unique("service_grant_target").on(t.callingService, t.targetEndpoint, t.scope),
]);

// ---------- 3.2 Payroll runs & approvals ----------

export const employeeColumns = () => ({
  employeeId: text("employee_id").notNull(),
  tenantId: text("tenant_id").notNull(),
  userId: text("user_id").notNull(),
  fullName: text("full_name").notNull(),
  status: text("status", { enum: ["active", "terminated"] }).notNull(),
  // D15 addition: gross pay per pay period, in cents.
  payRateCents: integer("pay_rate_cents").notNull(),
});
export const employee = sqliteTable("employee", employeeColumns(), (t) => [
  primaryKey({ columns: [t.employeeId] }),
  unique("employee_tenant_key").on(t.tenantId, t.employeeId),
  unique("employee_tenant_user").on(t.tenantId, t.userId),
  foreignKey({ name: "employee_user_fk", columns: [t.tenantId, t.userId], foreignColumns: [appUser.tenantId, appUser.userId] }),
  check("employee_status_check", sql`${t.status} IN ('active', 'terminated')`),
  check("employee_pay_rate_check", sql`${t.payRateCents} > 0`),
]);

export const payrollRunColumns = () => ({
  runId: text("run_id").notNull(),
  tenantId: text("tenant_id").notNull(),
  payDate: text("pay_date").notNull(),
  scheduledRunDate: text("scheduled_run_date").notNull(),
  status: text("status", { enum: ["draft", "approved", "computed", "disbursed", "failed"] }).notNull(),
  createdBy: text("created_by").notNull(),
  approvedBy: text("approved_by"),
  // Addition (Turn 8): why a run failed (content_changed or computation_error); cleared when it is re-approved.
  failureReason: text("failure_reason"),
  // Addition (Turn 11): when the run was computed, so the D29 late flag can be shown later.
  computedAt: ts("computed_at"),
});
export const payrollRun = sqliteTable("payroll_run", payrollRunColumns(), (t) => [
  primaryKey({ columns: [t.runId] }),
  unique("payroll_run_tenant_key").on(t.tenantId, t.runId),
  foreignKey({ name: "payroll_run_created_by_fk", columns: [t.tenantId, t.createdBy], foreignColumns: [appUser.tenantId, appUser.userId] }),
  foreignKey({ name: "payroll_run_approved_by_fk", columns: [t.tenantId, t.approvedBy], foreignColumns: [appUser.tenantId, appUser.userId] }),
  check("payroll_run_status_check", sql`${t.status} IN ('draft', 'approved', 'computed', 'disbursed', 'failed')`),
  // L0-11 resilience backup: every run is scheduled one day before its pay date.
  check("payroll_run_day_early_check", sql`${t.scheduledRunDate} = date(${t.payDate}, '-1 day')`),
]);

export const approvalTokenColumns = () => ({
  tokenId: text("token_id").notNull(),
  tenantId: text("tenant_id").notNull(),
  runId: text("run_id").notNull(),
  issuedTo: text("issued_to").notNull(),
  keyVersion: integer("key_version").notNull(),
  issuedAt: ts("issued_at").notNull(),
  expiresAt: ts("expires_at").notNull(),
  redeemedAt: ts("redeemed_at"),
});
export const approvalToken = sqliteTable("approval_token", approvalTokenColumns(), (t) => [
  primaryKey({ columns: [t.tokenId] }),
  foreignKey({ name: "approval_token_run_fk", columns: [t.tenantId, t.runId], foreignColumns: [payrollRun.tenantId, payrollRun.runId] }),
  foreignKey({ name: "approval_token_issued_to_fk", columns: [t.tenantId, t.issuedTo], foreignColumns: [appUser.tenantId, appUser.userId] }),
  check("approval_token_expiry_check", sql`${t.expiresAt} > ${t.issuedAt}`),
]);

// ---------- 3.3 Banking & disbursement ----------

export const bankAccountColumns = () => ({
  bankAccountId: text("bank_account_id").notNull(),
  tenantId: text("tenant_id").notNull(),
  employeeId: text("employee_id").notNull(),
  routingNumber: blob("routing_number", { mode: "buffer" }).notNull(),
  accountNumber: blob("account_number", { mode: "buffer" }).notNull(),
  accountLast4: text("account_last4").notNull(),
  status: text("status", { enum: ["verified", "retired"] }).notNull(),
  verifiedAt: ts("verified_at").notNull(),
});
export const bankAccount = sqliteTable("bank_account", bankAccountColumns(), (t) => [
  primaryKey({ columns: [t.bankAccountId] }),
  unique("bank_account_tenant_key").on(t.tenantId, t.bankAccountId),
  foreignKey({ name: "bank_account_employee_fk", columns: [t.tenantId, t.employeeId], foreignColumns: [employee.tenantId, employee.employeeId] }),
  check("bank_account_status_check", sql`${t.status} IN ('verified', 'retired')`),
  check("bank_account_last4_check", sql`length(${t.accountLast4}) = 4`),
]);

export const payResultColumns = () => ({
  resultId: text("result_id").notNull(),
  tenantId: text("tenant_id").notNull(),
  runId: text("run_id").notNull(),
  employeeId: text("employee_id").notNull(),
  bankAccountId: text("bank_account_id").notNull(),
  grossPayCents: integer("gross_pay_cents").notNull(),
  netPayCents: integer("net_pay_cents").notNull(),
});
export const payResult = sqliteTable("pay_result", payResultColumns(), (t) => [
  primaryKey({ columns: [t.resultId] }),
  unique("pay_result_run_employee").on(t.runId, t.employeeId),
  foreignKey({ name: "pay_result_run_fk", columns: [t.tenantId, t.runId], foreignColumns: [payrollRun.tenantId, payrollRun.runId] }),
  foreignKey({ name: "pay_result_employee_fk", columns: [t.tenantId, t.employeeId], foreignColumns: [employee.tenantId, employee.employeeId] }),
  foreignKey({ name: "pay_result_bank_account_fk", columns: [t.tenantId, t.bankAccountId], foreignColumns: [bankAccount.tenantId, bankAccount.bankAccountId] }),
  check("pay_result_amount_check", sql`${t.netPayCents} >= 0 AND ${t.netPayCents} <= ${t.grossPayCents}`),
]);

// Addition (Turn 8): an employee a payroll run could not pay, reported rather than silently skipped (no verified
// bank account). Written in the same transaction as the run's pay results.
export const payExceptionColumns = () => ({
  exceptionId: text("exception_id").notNull(),
  tenantId: text("tenant_id").notNull(),
  runId: text("run_id").notNull(),
  employeeId: text("employee_id").notNull(),
  reason: text("reason", { enum: ["no_verified_bank_account"] }).notNull(),
});
export const payException = sqliteTable("pay_exception", payExceptionColumns(), (t) => [
  primaryKey({ columns: [t.exceptionId] }),
  unique("pay_exception_run_employee").on(t.runId, t.employeeId),
  foreignKey({ name: "pay_exception_run_fk", columns: [t.tenantId, t.runId], foreignColumns: [payrollRun.tenantId, payrollRun.runId] }),
  foreignKey({ name: "pay_exception_employee_fk", columns: [t.tenantId, t.employeeId], foreignColumns: [employee.tenantId, employee.employeeId] }),
  check("pay_exception_reason_check", sql`${t.reason} IN ('no_verified_bank_account')`),
]);

export const bankAccountChangeColumns = () => ({
  changeId: text("change_id").notNull(),
  tenantId: text("tenant_id").notNull(),
  employeeId: text("employee_id").notNull(),
  requestedBy: text("requested_by").notNull(),
  newRoutingNumber: blob("new_routing_number", { mode: "buffer" }).notNull(),
  newAccountNumber: blob("new_account_number", { mode: "buffer" }).notNull(),
  status: text("status", { enum: ["pending", "confirmed", "rejected"] }).notNull(),
  requestedAt: ts("requested_at").notNull(),
  resolvedAt: ts("resolved_at"),
  // Addition (Turn 9): how and by whom a change was resolved. "superseded": a newer request replaced it.
  resolution: text("resolution", { enum: ["confirmed", "rejected", "superseded"] }),
  resolvedBy: text("resolved_by"),
});
export const bankAccountChange = sqliteTable("bank_account_change", bankAccountChangeColumns(), (t) => [
  primaryKey({ columns: [t.changeId] }),
  unique("bank_account_change_tenant_key").on(t.tenantId, t.changeId),
  foreignKey({ name: "bank_account_change_employee_fk", columns: [t.tenantId, t.employeeId], foreignColumns: [employee.tenantId, employee.employeeId] }),
  foreignKey({ name: "bank_account_change_requested_by_fk", columns: [t.tenantId, t.requestedBy], foreignColumns: [appUser.tenantId, appUser.userId] }),
  check("bank_account_change_status_check", sql`${t.status} IN ('pending', 'confirmed', 'rejected')`),
]);

// D15 addition: the out-of-band confirmation code for a pending bank account change (L2-11).
export const verificationCodeColumns = () => ({
  codeId: text("code_id").notNull(),
  tenantId: text("tenant_id").notNull(),
  changeId: text("change_id").notNull(),
  codeHash: text("code_hash").notNull(),
  attempts: integer("attempts").notNull(),
  expiresAt: ts("expires_at").notNull(),
  consumedAt: ts("consumed_at"),
});
export const verificationCode = sqliteTable("verification_code", verificationCodeColumns(), (t) => [
  primaryKey({ columns: [t.codeId] }),
  foreignKey({ name: "verification_code_change_fk", columns: [t.tenantId, t.changeId], foreignColumns: [bankAccountChange.tenantId, bankAccountChange.changeId] }),
]);

export const achBatchColumns = () => ({
  batchId: text("batch_id").notNull(),
  tenantId: text("tenant_id").notNull(),
  runId: text("run_id").notNull(),
  idempotencyKey: text("idempotency_key").notNull(),
  // D15 addition: the generated ACH file, encrypted at rest like the bank account columns.
  fileBody: blob("file_body", { mode: "buffer" }).notNull(),
  signature: blob("signature", { mode: "buffer" }),
  signingKeyVersion: integer("signing_key_version"),
  status: text("status", { enum: ["built", "signed", "sent", "rejected"] }).notNull(),
  createdAt: ts("created_at").notNull(),
  sentAt: ts("sent_at"),
  // Additions (Turn 10): the control totals checked before signing, and the bank's answer.
  entryCount: integer("entry_count"),
  totalCreditCents: integer("total_credit_cents"),
  bankReference: text("bank_reference"),
  rejectionReason: text("rejection_reason"),
});
export const achBatch = sqliteTable("ach_batch", achBatchColumns(), (t) => [
  primaryKey({ columns: [t.batchId] }),
  unique("ach_batch_run").on(t.runId),
  unique("ach_batch_idempotency_key").on(t.idempotencyKey),
  foreignKey({ name: "ach_batch_run_fk", columns: [t.tenantId, t.runId], foreignColumns: [payrollRun.tenantId, payrollRun.runId] }),
  check("ach_batch_status_check", sql`${t.status} IN ('built', 'signed', 'sent', 'rejected')`),
]);
