import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { withPlatform } from "@/data/db/platform-scope";
import { withTenant } from "@/data/db/tenant-scope";
import { insertVerifiedAccount } from "@/services/bank-account/repository";
import { getEmployee } from "@/services/engine/repository";
import { idsFor, rawSqlite, setupSeededDatabase } from "../helpers/database";

// L2-16 (Critical): app-code-only tenant isolation writes results to the wrong tenant.
// Primary control: BEFORE INSERT/UPDATE/DELETE triggers that compare tenant_id with current_tenant(), so the database
// itself rejects a mismatched write even when application code is wrong or bypassed. Composite (tenant_id, id)
// foreign keys stop a row in one tenant from referencing a row in another.

setupSeededDatabase();

describe("L2-16: tenant A cannot write tenant B's rows", () => {
  describe("through the repository", () => {
    it("an update in tenant A's scope cannot change tenant B's row", () => {
      const [globexEmployee] = idsFor("globex").employeeIds;
      const changed = withTenant("acme", (s) =>
        s.update("employee", { fullName: "Changed by acme" }, (t) => eq(t.employeeId, globexEmployee)),
      );
      expect(changed).toBe(0);
      expect(withTenant("globex", (s) => getEmployee(s, globexEmployee)?.fullName)).not.toBe("Changed by acme");
    });

    it("a delete in tenant A's scope cannot remove tenant B's row", () => {
      const globex = idsFor("globex");
      expect(withTenant("acme", (s) => s.delete("session", (t) => eq(t.userId, globex.userIds[0])))).toBe(0);
      expect(withTenant("acme", (s) => s.delete("employee", (t) => eq(t.employeeId, globex.employeeIds[0])))).toBe(0);
    });

    it("tenant A cannot attach a row to tenant B's employee (composite foreign key)", () => {
      const [globexEmployee] = idsFor("globex").employeeIds;
      expect(() =>
        withTenant("acme", (s) =>
          insertVerifiedAccount(s, globexEmployee, { routingNumber: "011000015", accountNumber: "555500001111" }, new Date()),
        ),
      ).toThrow(/FOREIGN KEY constraint failed/);
    });
  });

  describe("bypassing the repository with raw SQL on the base tables", () => {
    const insertEmployee = "INSERT INTO employee (employee_id, tenant_id, user_id, full_name, status, pay_rate_cents) VALUES (?, ?, ?, 'Mallory', 'active', 100)";

    it("the database rejects an insert for another tenant", () => {
      const [globexUser] = idsFor("globex").userIds;
      withTenant("acme", () => {
        expect(() => rawSqlite().prepare(insertEmployee).run("evil-1", "globex", globexUser)).toThrow(
          /tenant isolation: insert into employee denied/,
        );
      });
    });

    it("the database rejects updating or deleting another tenant's row", () => {
      const [globexEmployee] = idsFor("globex").employeeIds;
      withTenant("acme", () => {
        const db = rawSqlite();
        expect(() => db.prepare("UPDATE employee SET full_name = 'x' WHERE employee_id = ?").run(globexEmployee)).toThrow(
          /tenant isolation: update of employee denied/,
        );
        expect(() => db.prepare("DELETE FROM employee WHERE employee_id = ?").run(globexEmployee)).toThrow(
          /tenant isolation: delete from employee denied/,
        );
      });
    });

    it("the database rejects moving a row into another tenant", () => {
      const [acmeEmployee] = idsFor("acme").employeeIds;
      withTenant("acme", () => {
        expect(() => rawSqlite().prepare("UPDATE employee SET tenant_id = 'globex' WHERE employee_id = ?").run(acmeEmployee)).toThrow(
          /tenant isolation: update of employee denied/,
        );
      });
    });

    it("the database rejects every write when no tenant is set", () => {
      const acme = idsFor("acme");
      const db = rawSqlite();
      expect(() => db.prepare(insertEmployee).run("evil-2", "acme", acme.userIds[0])).toThrow(/tenant isolation: insert/);
      expect(() => db.prepare("UPDATE app_user SET status = 'disabled' WHERE user_id = ?").run(acme.hrAdminId)).toThrow(
        /tenant isolation: update/,
      );
      expect(() => db.prepare("DELETE FROM bank_account").run()).toThrow(/tenant isolation: delete/);
    });

    it("service grants are writable only in a platform scope", () => {
      const insertGrant = "INSERT INTO service_grant VALUES (?, 'engine', '/api/internal/ach', 'ach:build', 0)";
      expect(() => rawSqlite().prepare(insertGrant).run("g1")).toThrow(/platform scope/);
      withTenant("acme", () => {
        expect(() => rawSqlite().prepare(insertGrant).run("g2")).toThrow(/platform scope/);
      });
      withPlatform(() => {
        expect(rawSqlite().prepare(insertGrant).run("g3").changes).toBe(1);
      });
    });
  });
});
