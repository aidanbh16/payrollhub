// The 15 prioritized threats (Assignment 4, in rank order) and the files holding each one's controls. The traceability
// check (scripts/traceability.ts) reads this list, so a threat ID that is not here is rejected wherever a test uses it.
//
// Test tags (in describe or test titles; a test inherits the tags of the describes around it):
//   [L2-11]      the test attacks the threat's primary control
//   [L2-11 DiD]  the test attacks one of its defense-in-depth controls
// npm test -- L2-11 runs every vitest test tagged with that threat; npm run test:e2e -- L2-11 does the same in the browser.

export interface Threat {
  id: string;
  rank: number;
  /** "Threat (short)" from Assignment 4. */
  threat: string;
  /** Files (or folders, ending in /) holding the primary control. */
  primary: string[];
  /** Files (or folders, ending in /) holding defense-in-depth controls; empty when the threat has none. */
  defenseInDepth: string[];
}

export const THREATS: Threat[] = [
  {
    id: "L1-05",
    rank: 1,
    threat: "Credential-stuffing flood on the API Gateway login route",
    primary: ["proxy.ts", "edge/rate-limiter.ts", "edge/login-routes.ts", "edge/route-policy.ts", "edge/known-devices.ts", "edge/client-ip.ts"],
    defenseInDepth: [],
  },
  {
    id: "L1-14",
    rank: 2,
    threat: "Missing row-level predicate lets one tenant read another tenant's rows",
    primary: ["migrations/0001_tenant_isolation.sql", "data/db/views.ts", "data/db/tenant-scope.ts", "data/db/scope-state.ts"],
    defenseInDepth: ["eslint.config.mjs"],
  },
  {
    id: "L2-04",
    rank: 3,
    threat: "tenantId path and token mismatch writes a run into another tenant",
    primary: ["application/http/route.ts", "application/validation/", "app/api/tenants/[tenantId]/runs/"],
    defenseInDepth: ["data/db/tenant-scope.ts", "services/identity/service-tokens.ts"],
  },
  {
    id: "L2-16",
    rank: 4,
    threat: "App-code-only tenant isolation writes results to the wrong tenant",
    primary: ["migrations/0001_tenant_isolation.sql", "migrations/0000_tables.sql"],
    defenseInDepth: ["eslint.config.mjs"],
  },
  {
    id: "L2-01",
    rank: 5,
    threat: "Captured approval token replayed to launch an unauthorized payroll run",
    primary: ["services/approval/approval-service.ts", "services/approval/repository.ts"],
    defenseInDepth: [
      "app/api/tenants/[tenantId]/runs/[runId]/approve/route.ts",
      "services/identity/step-up.ts",
      "app/(console)/approver/approve-run.tsx",
      "migrations/0007_approval_immutability.sql",
      "services/engine/engine-service.ts",
      "edge/security-headers.ts",
      "eslint.config.mjs",
    ],
  },
  {
    id: "L2-02",
    rank: 6,
    threat: "Unverified approval-token signature authorizes a run as any admin",
    primary: ["services/engine/engine-service.ts", "services/approval/approval-service.ts", "services/engine/run-content.ts"],
    defenseInDepth: [
      "app/api/internal/engine/",
      "app/api/tenants/[tenantId]/runs/[runId]/start/route.ts",
      "application/validation/runs.ts",
      "migrations/0009_engine_integrity.sql",
    ],
  },
  {
    id: "L1-19",
    rank: 7,
    threat: "Unchecked service-to-service call reaches internal Payroll Engine endpoints",
    primary: ["services/identity/service-tokens.ts", "data/keys/kms.ts", "app/api/internal/", "application/mint-as-bff.ts"],
    defenseInDepth: ["application/http/route.ts", "config/env.ts", "instrumentation-node.ts", "scripts/lib/seed.ts"],
  },
  {
    id: "L2-13",
    rank: 8,
    threat: "Missing idempotency key double-submits the ACH batch and double-pays",
    primary: ["services/ach/ach-service.ts", "migrations/0000_tables.sql", "migrations/0013_ach_integrity.sql"],
    defenseInDepth: ["partners/mock-bank/server.ts", "app/api/tenants/[tenantId]/runs/[runId]/disburse/route.ts"],
  },
  {
    id: "L0-01",
    rank: 9,
    threat: "HR Admin account takeover with no MFA",
    primary: ["application/auth/dal.ts", "services/identity/totp.ts", "services/identity/login.ts"],
    defenseInDepth: [
      "services/identity/sessions.ts",
      "services/identity/step-up.ts",
      "application/auth/session-cookies.ts",
      "application/http/forms.ts",
      "proxy.ts",
      "edge/security-headers.ts",
      "app/(console)/",
      "app/(employee)/",
      "app/_components/bfcache-guard.tsx",
      "partners/mock-mail/mail.ts",
      "migrations/0011_bank_change_integrity.sql",
      "scripts/lib/seed.ts",
    ],
  },
  {
    id: "L0-11",
    rank: 10,
    threat: "Platform-wide PayrollHub outage on a pay date",
    primary: ["edge/waf.ts", "edge/route-policy.ts", "proxy.ts", "next.config.ts"],
    defenseInDepth: ["services/engine/engine-service.ts", "data/db/tables.ts", "edge/rate-limiter.ts"],
  },
  {
    id: "L2-18",
    rank: 11,
    threat: "Approval tokens do not expire or rotate",
    primary: ["services/approval/approval-service.ts", "data/keys/kms.ts", "scripts/rotate-key.ts"],
    defenseInDepth: ["migrations/0007_approval_immutability.sql"],
  },
  {
    id: "L1-20",
    rank: 12,
    threat: "Forged SSO assertion signs in as any employee of a tenant",
    primary: ["services/identity/sso.ts", "app/api/auth/sso/[tenantId]/callback/route.ts"],
    defenseInDepth: ["services/identity/repository.ts", "partners/mock-idp/idp.ts"],
  },
  {
    id: "L2-11",
    rank: 13,
    threat: "ACH generator pays a bank account whose change was never verified",
    primary: [
      "services/bank-account/bank-account-service.ts",
      "services/bank-account/repository.ts",
      "app/api/tenants/[tenantId]/bank-account/",
      "app/(employee)/employee/bank-change/",
      "partners/mock-mail/mail.ts",
    ],
    defenseInDepth: [
      "migrations/0011_bank_change_integrity.sql",
      "services/bank-account/validation.ts",
      "services/bank-account/notify.ts",
      "services/engine/run-content.ts",
      "services/ach/ach-service.ts",
      "application/http/forms.ts",
      "app/(console)/admin/admin-console.tsx",
      "eslint.config.mjs",
    ],
  },
  {
    id: "L2-12",
    rank: 14,
    threat: "Generated ACH file in logs exposes bank and routing numbers",
    primary: ["data/log/logger.ts", "instrumentation.ts", "instrumentation-node.ts", "application/http/route.ts"],
    defenseInDepth: ["services/ach/ach-service.ts", "services/ach/repository.ts", "data/crypto/field-encryption.ts"],
  },
  {
    id: "L1-22",
    rank: 15,
    threat: "Unsigned ACH batch altered in transit to redirect funds",
    primary: ["services/ach/ach-service.ts", "services/ach/nacha.ts", "data/keys/kms.ts", "partners/mock-bank/server.ts"],
    defenseInDepth: ["services/ach/bank-client.ts", "scripts/lib/pki.ts"],
  },
];
