import { randomBytes, randomUUID } from "node:crypto";
import { generateSecret } from "otplib";
import { withPlatform } from "@/data/db/platform-scope";
import { withTenant } from "@/data/db/tenant-scope";
import { provisionSigningKeys } from "@/data/keys/kms";
import { provisionTenantIdp } from "@/partners/mock-idp/idp";
import { provisionMailboxes } from "@/partners/mock-mail/mail";
import { insertVerifiedAccount } from "@/services/bank-account/repository";
import { insertEmployee } from "@/services/engine/repository";
import { getTenant, insertIdpConfig, insertServiceGrant, insertTenant, insertUser } from "@/services/identity/repository";
import type { ServiceEndpoint, ServiceName } from "@/services/identity/service-tokens";
import { hashPassword } from "@/services/identity/password";
import { provisionBank } from "./bank-setup";
import { idpPasswordFor, mailboxPasswordFor, otpauthLink, readStaffCredential, writeDevCredentials } from "./dev-credentials";

// Development seed data. No credential is here: staff passwords and TOTP secrets, employee IdP passwords, and mailbox
// passwords are random per install (see writeCredentials). Routing numbers are publicly listed ABA numbers with valid
// check digits; account numbers are made up.

export interface SeedStaff {
  email: string;
}

export interface SeedEmployee {
  email: string;
  fullName: string;
  payRateCents: number;
  routingNumber: string;
  accountNumber: string;
}

export interface SeedTenant {
  tenantId: string;
  name: string;
  withholdingRateBp: number;
  hrAdmin: SeedStaff;
  approver: SeedStaff;
  employees: SeedEmployee[];
}

export const SEED_TENANTS: SeedTenant[] = [
  {
    tenantId: "acme",
    name: "Acme Corporation",
    withholdingRateBp: 2200,
    hrAdmin: { email: "admin@acme.test" },
    approver: { email: "approver@acme.test" },
    employees: [
      { email: "alice@acme.test", fullName: "Alice Anders", payRateCents: 312_500, routingNumber: "011000015", accountNumber: "730100000101" },
      { email: "bob@acme.test", fullName: "Bob Brandt", payRateCents: 287_500, routingNumber: "021000021", accountNumber: "730100000202" },
      { email: "carol@acme.test", fullName: "Carol Chen", payRateCents: 341_667, routingNumber: "026009593", accountNumber: "730100000303" },
    ],
  },
  {
    tenantId: "globex",
    name: "Globex Inc.",
    withholdingRateBp: 2000,
    hrAdmin: { email: "admin@globex.test" },
    approver: { email: "approver@globex.test" },
    employees: [
      { email: "dana@globex.test", fullName: "Dana Diaz", payRateCents: 295_000, routingNumber: "121000358", accountNumber: "840200000404" },
      { email: "eli@globex.test", fullName: "Eli Evans", payRateCents: 265_000, routingNumber: "111000025", accountNumber: "840200000505" },
      { email: "fay@globex.test", fullName: "Fay Fischer", payRateCents: 358_333, routingNumber: "122000247", accountNumber: "840200000606" },
    ],
  },
];

/**
 * ServiceGrant (Section 3.1): which service may call which endpoint (L1-19). Anything not listed is refused.
 * "bff" is the Next.js application layer calling on behalf of a signed-in user.
 */
export const SERVICE_GRANTS: { caller: ServiceName; endpoint: ServiceEndpoint; scope: string }[] = [
  { caller: "bff", endpoint: "engine.createRun", scope: "payroll-run:create" },
  { caller: "bff", endpoint: "engine.getRun", scope: "payroll-run:read" },
  { caller: "approval", endpoint: "engine.getRun", scope: "payroll-run:read" },
  { caller: "ach", endpoint: "engine.getRun", scope: "payroll-run:read" },
  { caller: "engine", endpoint: "ach.getBatch", scope: "ach-batch:read" },
  { caller: "bff", endpoint: "engine.updateRun", scope: "payroll-run:update-draft" },
  { caller: "bff", endpoint: "engine.listRuns", scope: "payroll-run:read" },
  { caller: "bff", endpoint: "engine.reviewRun", scope: "payroll-run:review" },
  { caller: "bff", endpoint: "engine.payStatements", scope: "pay-statement:read-own" },
  { caller: "bff", endpoint: "bankAccount.adminList", scope: "bank-account:read-last4" },
  { caller: "bff", endpoint: "ach.getBatch", scope: "ach-batch:read" },
  { caller: "bff", endpoint: "approval.issueToken", scope: "approval-token:issue" },
  { caller: "engine", endpoint: "approval.redeemToken", scope: "approval-token:redeem" },
  { caller: "bff", endpoint: "engine.startRun", scope: "payroll-run:start" },
  { caller: "engine", endpoint: "bankAccount.readVerified", scope: "bank-account:read-verified" },
  { caller: "approval", endpoint: "bankAccount.readVerified", scope: "bank-account:read-verified" },
  { caller: "bff", endpoint: "bankAccount.summary", scope: "bank-account:read-own" },
  { caller: "bff", endpoint: "ach.disburse", scope: "ach-batch:disburse" },
  { caller: "ach", endpoint: "bankAccount.readPayable", scope: "bank-account:read-payable" },
  { caller: "bff", endpoint: "bankAccount.viewChange", scope: "bank-account:view-change" },
  { caller: "bff", endpoint: "bankAccount.requestChange", scope: "bank-account:request-change" },
  { caller: "bff", endpoint: "bankAccount.resolveChange", scope: "bank-account:resolve-change" },
];

/**
 * Writes the development credentials file (scripts/lib/dev-credentials.ts) and returns the staff passwords, staff TOTP
 * secrets, and mailbox passwords. All are random per install: mailbox passwords (D30), so knowing a PayrollHub or IdP
 * password, or taking over an HR Admin account, says nothing about any mailbox password; staff passwords (144 bits)
 * and TOTP secrets (160 bits, from otplib's CSPRNG), so no secret that guards an install is in the source or the
 * README. The file stands in for each person knowing their own.
 */
function writeCredentials(): {
  idpPasswords: Map<string, string>;
  staffPasswords: Map<string, string>;
  totpSecrets: Map<string, string>;
  mailboxes: { address: string; password: string }[];
} {
  const staffEmails = SEED_TENANTS.flatMap((t) => [t.hrAdmin.email, t.approver.email]);
  const staffPasswords = new Map(staffEmails.map((email) => [email, randomBytes(18).toString("base64url")]));
  // Employee passwords at the stand-in IdP (D22), 144 bits each (RT-02: no install shares a password with another).
  const idpPasswords = new Map(SEED_TENANTS.flatMap((t) => t.employees).map((e) => [e.email, randomBytes(18).toString("base64url")]));
  const totpSecrets = new Map(staffEmails.map((email) => [email, generateSecret()]));
  const mailboxes = SEED_TENANTS.flatMap((t) => [t.hrAdmin.email, t.approver.email, ...t.employees.map((e) => e.email)]).map((address) => ({
    address,
    password: randomBytes(18).toString("base64url"),
  }));
  writeDevCredentials({
    staff: SEED_TENANTS.flatMap((t) =>
      ([[t.hrAdmin, "hr_admin"], [t.approver, "approver"]] as const).map(([s, role]) => ({
        organization: t.tenantId,
        email: s.email,
        role,
        password: staffPasswords.get(s.email)!,
        totpSecret: totpSecrets.get(s.email)!,
        otpauth: otpauthLink(t.tenantId, s.email, totpSecrets.get(s.email)!),
      })),
    ),
    employees: SEED_TENANTS.flatMap((t) => t.employees.map((e) => ({ organization: t.tenantId, email: e.email, idpPassword: idpPasswords.get(e.email)! }))),
    mailboxes,
  });
  return { idpPasswords, staffPasswords, totpSecrets, mailboxes };
}

export { mailboxPasswordFor };

/** A seeded employee's stand-in IdP password for this install, from the development credentials file. */
export const seededIdpPassword = (email: string): string => idpPasswordFor(email);

/** A seeded staff account's password for this install, from the development credentials file. */
export const seededPassword = (email: string): string => readStaffCredential(email).password;

/** A seeded staff account's TOTP secret for this install, from the development credentials file. */
export const seededTotpSecret = (email: string): string => readStaffCredential(email).totpSecret;

export const ssoSubjectFor = (tenantId: string, email: string) => `${tenantId}-idp|${email}`;

export async function seedDatabase(): Promise<void> {
  const now = new Date();
  provisionSigningKeys();
  await provisionBank();
  const { idpPasswords, staffPasswords, totpSecrets, mailboxes } = writeCredentials();
  await provisionMailboxes(mailboxes);
  withPlatform((p) => {
    for (const g of SERVICE_GRANTS) {
      insertServiceGrant(p, { grantId: randomUUID(), callingService: g.caller, targetEndpoint: g.endpoint, scope: g.scope, createdAt: now });
    }
  });
  for (const t of SEED_TENANTS) {
    // Hashing and key generation are async, so they run before the synchronous tenant scope opens.
    const adminHash = await hashPassword(staffPasswords.get(t.hrAdmin.email)!);
    const approverHash = await hashPassword(staffPasswords.get(t.approver.email)!);
    const idp = await provisionTenantIdp(
      t.tenantId,
      t.employees.map((e) => ({ email: e.email, subject: ssoSubjectFor(t.tenantId, e.email), password: idpPasswords.get(e.email)! })),
    );

    withTenant(t.tenantId, (s) => {
      if (getTenant(s)) throw new Error(`Tenant "${t.tenantId}" already exists. Run npm run db:reset for a clean state.`);
      insertTenant(s, { name: t.name, status: "active", withholdingRateBp: t.withholdingRateBp, createdAt: now });
      insertIdpConfig(s, {
        idpConfigId: randomUUID(),
        issuer: idp.issuer,
        audience: idp.audience,
        signingCert: idp.publicKeyPem,
        certExpiresAt: new Date(now.getTime() + 365 * 24 * 60 * 60 * 1000),
      });

      for (const [staff, role, passwordHash] of [
        [t.hrAdmin, "hr_admin", adminHash],
        [t.approver, "approver", approverHash],
      ] as const) {
        insertUser(s, {
          userId: randomUUID(),
          email: staff.email,
          role,
          mfaEnrolled: true,
          ssoSubject: null,
          status: "active",
          passwordHash,
          totpSecret: totpSecrets.get(staff.email)!,
        });
      }

      for (const e of t.employees) {
        const userId = randomUUID();
        const employeeId = randomUUID();
        insertUser(s, {
          userId,
          email: e.email,
          role: "employee",
          mfaEnrolled: false,
          ssoSubject: ssoSubjectFor(t.tenantId, e.email),
          status: "active",
          passwordHash: null,
        });
        insertEmployee(s, { employeeId, userId, fullName: e.fullName, status: "active", payRateCents: e.payRateCents });
        insertVerifiedAccount(s, employeeId, { routingNumber: e.routingNumber, accountNumber: e.accountNumber }, now);
      }
    });
  }
}
