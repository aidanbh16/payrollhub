import { randomBytes, randomUUID } from "node:crypto";
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
import { mailboxPasswordFor, otpauthLink, writeDevCredentials } from "./dev-credentials";

// Development seed data. Every password and TOTP secret here is a development-only value documented in the
// README; none of them protect anything real. Routing numbers are publicly listed ABA numbers with valid check
// digits; account numbers are made up.

export interface SeedStaff {
  email: string;
  password: string;
  totpSecret: string;
}

export interface SeedEmployee {
  email: string;
  fullName: string;
  /** Password at the tenant's stand-in SSO IdP (D22). Employees have no PayrollHub password. */
  idpPassword: string;
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
    hrAdmin: { email: "admin@acme.test", password: "Acme-Admin-Dev-2026!", totpSecret: "MFRW2ZJNMFSG22LOFVSGK5RNORXXI4BB" },
    approver: { email: "approver@acme.test", password: "Acme-Approver-Dev-2026!", totpSecret: "MFRW2ZJNMFYHA4TWFVSGK5RNORXXI4BB" },
    employees: [
      { email: "alice@acme.test", fullName: "Alice Anders", idpPassword: "Acme-Employee-Dev-2026!", payRateCents: 312_500, routingNumber: "011000015", accountNumber: "730100000101" },
      { email: "bob@acme.test", fullName: "Bob Brandt", idpPassword: "Acme-Employee-Dev-2026!", payRateCents: 287_500, routingNumber: "021000021", accountNumber: "730100000202" },
      { email: "carol@acme.test", fullName: "Carol Chen", idpPassword: "Acme-Employee-Dev-2026!", payRateCents: 341_667, routingNumber: "026009593", accountNumber: "730100000303" },
    ],
  },
  {
    tenantId: "globex",
    name: "Globex Inc.",
    withholdingRateBp: 2000,
    hrAdmin: { email: "admin@globex.test", password: "Globex-Admin-Dev-2026!", totpSecret: "M5WG6YTYFVQWI3LJNYWWIZLWFVXXI4BB" },
    approver: { email: "approver@globex.test", password: "Globex-Approver-Dev-2026!", totpSecret: "M5WG6YTYFVQXA4DSOYWWIZLWFVXXI4BB" },
    employees: [
      { email: "dana@globex.test", fullName: "Dana Diaz", idpPassword: "Globex-Employee-Dev-2026!", payRateCents: 295_000, routingNumber: "121000358", accountNumber: "840200000404" },
      { email: "eli@globex.test", fullName: "Eli Evans", idpPassword: "Globex-Employee-Dev-2026!", payRateCents: 265_000, routingNumber: "111000025", accountNumber: "840200000505" },
      { email: "fay@globex.test", fullName: "Fay Fischer", idpPassword: "Globex-Employee-Dev-2026!", payRateCents: 358_333, routingNumber: "122000247", accountNumber: "840200000606" },
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
 * Writes the development credentials file (scripts/lib/dev-credentials.ts) and returns the mailbox passwords. Mailbox
 * passwords are random per install (D30), so knowing a PayrollHub or IdP password, or taking over an HR Admin account,
 * says nothing about any mailbox password; the file stands in for each person knowing their own.
 */
function writeCredentials(): { address: string; password: string }[] {
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
        password: s.password,
        totpSecret: s.totpSecret,
        otpauth: otpauthLink(t.tenantId, s.email, s.totpSecret),
      })),
    ),
    employees: SEED_TENANTS.flatMap((t) => t.employees.map((e) => ({ organization: t.tenantId, email: e.email, idpPassword: e.idpPassword }))),
    mailboxes,
  });
  return mailboxes;
}

export { mailboxPasswordFor };

export const ssoSubjectFor = (tenantId: string, email: string) => `${tenantId}-idp|${email}`;

export async function seedDatabase(): Promise<void> {
  const now = new Date();
  provisionSigningKeys();
  await provisionBank();
  await provisionMailboxes(writeCredentials());
  withPlatform((p) => {
    for (const g of SERVICE_GRANTS) {
      insertServiceGrant(p, { grantId: randomUUID(), callingService: g.caller, targetEndpoint: g.endpoint, scope: g.scope, createdAt: now });
    }
  });
  for (const t of SEED_TENANTS) {
    // Hashing and key generation are async, so they run before the synchronous tenant scope opens.
    const adminHash = await hashPassword(t.hrAdmin.password);
    const approverHash = await hashPassword(t.approver.password);
    const idp = await provisionTenantIdp(
      t.tenantId,
      t.employees.map((e) => ({ email: e.email, subject: ssoSubjectFor(t.tenantId, e.email), password: e.idpPassword })),
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
          totpSecret: staff.totpSecret,
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
