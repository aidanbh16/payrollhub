import { describe, expect, it } from "vitest";
import { withTenant, type TenantView } from "@/data/db/tenant-scope";
import * as views from "@/data/db/views";
import { listVerifiedAccounts } from "@/services/bank-account/repository";
import { getEmployee, listEmployees } from "@/services/engine/repository";
import { findUserByEmail, getTenant, getUser, listUsers } from "@/services/identity/repository";
import { SEED_TENANTS } from "@/scripts/lib/seed";
import { idsFor, rawSqlite, setupSeededDatabase } from "../helpers/database";

// L1-14 (Critical): a missing row-level predicate lets one tenant read another tenant's rows.
// Primary control: the tenant-filtered views (migrations/0001_tenant_isolation.sql), which the ORM reads exclusively.

const TENANT_VIEWS: TenantView[] = [
  views.vTenant, views.vAppUser, views.vSession, views.vTenantIdpConfig, views.vEmployee, views.vPayrollRun,
  views.vApprovalToken, views.vPayResult, views.vBankAccount, views.vBankAccountChange, views.vVerificationCode, views.vAchBatch, views.vSsoAssertion, views.vServiceTokenUse, views.vPayException,
];

setupSeededDatabase();

describe("[L1-14] tenant A cannot read tenant B's rows", () => {
  it("every tenant view returns only the scope tenant's rows", () => {
    for (const tenantId of ["acme", "globex"]) {
      withTenant(tenantId, (s) => {
        for (const view of TENANT_VIEWS) {
          for (const row of s.read(view).all()) expect(row.tenantId).toBe(tenantId);
        }
      });
    }
  });

  it("a query with no tenant filter of its own still returns only the current tenant", () => {
    // listUsers/listEmployees have no WHERE clause at all: the view supplies the predicate.
    withTenant("acme", (s) => {
      expect(getTenant(s)?.tenantId).toBe("acme");
      expect(listUsers(s).map((u) => u.email).sort()).toEqual(
        ["admin@acme.test", "alice@acme.test", "approver@acme.test", "bob@acme.test", "carol@acme.test"],
      );
      expect(listEmployees(s)).toHaveLength(3);
    });
  });

  it("looking up another tenant's rows by id or email returns nothing", () => {
    const globex = idsFor("globex");
    withTenant("acme", (s) => {
      for (const id of globex.employeeIds) expect(getEmployee(s, id)).toBeUndefined();
      for (const id of globex.userIds) expect(getUser(s, id)).toBeUndefined();
      expect(findUserByEmail(s, "admin@globex.test")).toBeUndefined();
    });
  });

  it("bank accounts are visible only to their own tenant", () => {
    const acmeAccounts = new Set(SEED_TENANTS[0].employees.map((e) => e.accountNumber));
    const seen = withTenant("acme", (s) => listVerifiedAccounts(s).map((a) => a.accountNumber));
    expect(seen).toHaveLength(3);
    for (const account of seen) expect(acmeAccounts.has(account)).toBe(true);
  });

  it("with no tenant set, every view returns nothing although the base tables hold rows", () => {
    const db = rawSqlite();
    for (const table of ["tenant", "app_user", "employee", "bank_account"]) {
      expect((db.prepare(`SELECT count(*) AS n FROM ${table}`).get() as { n: number }).n).toBeGreaterThan(0);
      expect((db.prepare(`SELECT count(*) AS n FROM v_${table}`).get() as { n: number }).n).toBe(0);
    }
  });
});
