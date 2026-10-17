import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { observeStatements } from "@/data/db/connection";
import { withPlatform } from "@/data/db/platform-scope";
import * as tables from "@/data/db/tables";
import { withTenant, type TenantScope } from "@/data/db/tenant-scope";
import { findApprovalToken } from "@/services/approval/repository";
import { getAchBatchForRun } from "@/services/ach/repository";
import { findOpenVerificationCode, getAccountChange, listVerifiedAccounts } from "@/services/bank-account/repository";
import { getEmployee, getPayrollRun, listEmployees, listPayExceptions, listPayResults, listPayrollRuns } from "@/services/engine/repository";
import {
  findAssertionUse, findSession, findUserByEmail, recordServiceTokenUse, getIdpConfig, getTenant, getTotpSecret, getUser, listServiceGrants, listUsers,
} from "@/services/identity/repository";
import { setupSeededDatabase } from "../helpers/database";
import { scanApplicationSource, scanSource, scanSqlTag, scanSqlTagUsage } from "../helpers/source-scan";

// D4: the ORM reads only from the tenant-filtered views, never from the base tables.

setupSeededDatabase();

const ALL_VIEWS = [
  "v_tenant", "v_app_user", "v_session", "v_tenant_idp_config", "v_service_grant", "v_employee", "v_payroll_run",
  "v_approval_token", "v_pay_result", "v_bank_account", "v_bank_account_change", "v_verification_code", "v_ach_batch",
  "v_sso_assertion", "v_service_token_use", "v_pay_exception",
];

function readSources(statements: string[]): string[] {
  return statements
    .filter((sql) => /^\s*select\b/i.test(sql))
    .flatMap((sql) => [...sql.matchAll(/\b(?:from|join)\s+[`"]?(\w+)[`"]?/gi)].map((m) => m[1]));
}

describe("[L1-14] D4: reads go through the views, not the base tables", () => {
  it("every SELECT issued by every repository read function targets a v_ view", () => {
    const statements: string[] = [];
    const stop = observeStatements((sql) => statements.push(sql));
    try {
      const id = randomUUID();
      withTenant("acme", (s) => {
        const admin = findUserByEmail(s, "admin@acme.test")!;
        getTenant(s);
        listUsers(s);
        getUser(s, admin.userId);
        getTotpSecret(s, admin.userId);
        findSession(s, id);
        findAssertionUse(s, id);
        recordServiceTokenUse(s, id, new Date(Date.now() + 60_000), new Date());
        getIdpConfig(s);
        const [employee] = listEmployees(s);
        getEmployee(s, employee.employeeId);
        listPayrollRuns(s);
        getPayrollRun(s, id);
        listPayResults(s, id);
        listPayExceptions(s, id);
        findApprovalToken(s, id);
        listVerifiedAccounts(s);
        getAccountChange(s, id);
        findOpenVerificationCode(s, id);
        getAchBatchForRun(s, id);
      });
      withPlatform((p) => listServiceGrants(p));
    } finally {
      stop();
    }

    const sources = readSources(statements);
    expect(sources.length).toBeGreaterThan(0);
    expect(sources.filter((name) => !name.startsWith("v_"))).toEqual([]);
    expect(new Set(sources)).toEqual(new Set(ALL_VIEWS));
  });

  it("read() refuses a base table at runtime, even when the type check is bypassed", () => {
    withTenant("acme", (s) => {
      expect(() => s.read(tables.employee as never)).toThrow(/only from the tenant-filtered views/);
    });
  });

  it("read() refuses a base table at compile time (checked by tsc --noEmit)", () => {
    // Never called: this exists so tsc fails if read() ever starts accepting base tables.
    const compileTimeOnly = (s: TenantScope) => {
      // @ts-expect-error base tables are not TenantView
      s.read(tables.employee);
    };
    expect(typeof compileTimeOnly).toBe("function");
  });
});

describe("[L1-14] D4: the test that fails on direct base-table access", () => {
  it("no application source file imports the raw handle or base tables, or reads base tables with raw SQL", () => {
    const { files, violations } = scanApplicationSource();
    expect(files.length).toBeGreaterThan(10);
    expect(files).toContain("services/engine/repository.ts");
    expect(violations).toEqual([]);
  });

  it("the scanner catches each kind of violation (so the test above can actually fail)", () => {
    const bad = [
      'import Database from "better-sqlite3";',
      'import { employee } from "@/data/db/tables";',
      'import { getConnection } from "../../data/db/connection";',
      'const rows = db.all("SELECT * FROM bank_account");',
      "// eslint-disable-next-line no-restricted-imports",
    ].join("\n");
    const problems = scanSource("services/engine/evil.ts", bad).map((v) => v.problem);
    expect(problems).toEqual([
      "imports better-sqlite3",
      "imports @/data/db/tables",
      "imports ../../data/db/connection",
      "raw SQL reads base table bank_account",
      "disables eslint-disable-next-line no-restricted-imports",
    ]);
    expect(scanSource("scripts/migrate.ts", 'import { migrateDatabase } from "@/data/db/migrate";')).toEqual([]);
  });
});

describe("[L1-14 DiD] [L2-16 DiD] D23: the sql tag is allowed only for CHECK constraints in data/db/tables.ts", () => {
  it("no source file, including data/, uses the sql tag beyond that exception", () => {
    const { files, violations } = scanSqlTagUsage();
    expect(files).toContain("data/db/tables.ts");
    expect(files).toContain("data/db/tenant-scope.ts");
    expect(violations).toEqual([]);
  });

  it("the scanner catches every other use of the sql tag (so the test above can actually fail)", () => {
    const tablesOk = ['check("a", sql`x > 0`),', 'check("b", sql`y IN (1, 2)`),'].join("\n");
    expect(scanSqlTag("data/db/tables.ts", tablesOk)).toEqual([]);
    const extraQuery = [tablesOk, "const q = sql`SELECT * FROM employee`;"].join("\n");
    expect(scanSqlTag("data/db/tables.ts", extraQuery).map((v) => v.problem)).toEqual([
      "uses the sql tag outside check() 1 time(s)",
    ]);
    expect(scanSqlTag("data/db/tables.ts", 'check("c", sql.raw("1=1"))').map((v) => v.problem)).toEqual([
      "uses sql.raw or another sql helper",
    ]);
    const repoQuery = ['import { eq, sql } from "drizzle-orm";', "const q = sql`DELETE FROM session`;"].join("\n");
    expect(scanSqlTag("data/db/tenant-scope.ts", repoQuery).map((v) => v.problem)).toEqual([
      "uses the sql tag",
      "imports sql from drizzle-orm",
    ]);
  });
});
