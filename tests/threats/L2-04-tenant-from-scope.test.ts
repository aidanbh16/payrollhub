import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { withTenant } from "@/data/db/tenant-scope";
import { getPayrollRun, insertPayrollRun } from "@/services/engine/repository";
import { idsFor, setupSeededDatabase } from "../helpers/database";

// L2-04 (Critical): a tenantId path/token mismatch writes a run into another tenant.
// Primary control is in the route handlers (Layer 3). This layer is the backup: the repository never accepts a
// tenantId from its caller; every row takes the scope's tenant, and the triggers check it again.

setupSeededDatabase();

describe("L2-04 backup: the tenant comes from the scope, never from the caller", () => {
  it("rejects an insert that names its own tenantId", () => {
    expect(() =>
      withTenant("acme", (s) =>
        // A caller trying to smuggle a different tenant past the types.
        s.insert("payrollRun", { runId: randomUUID(), tenantId: "globex" } as never),
      ),
    ).toThrow(/tenantId is set by the tenant scope/);
  });

  it("rejects an update that tries to change tenantId", () => {
    expect(() => withTenant("acme", (s) => s.update("employee", { tenantId: "globex" } as never, () => undefined))).toThrow(
      /tenantId is set by the tenant scope/,
    );
  });

  it("a row written in a scope belongs to that scope's tenant and is invisible to others", () => {
    const runId = randomUUID();
    const { hrAdminId } = idsFor("globex");
    withTenant("globex", (s) =>
      insertPayrollRun(s, { runId, payDate: "2026-11-13", status: "draft", createdBy: hrAdminId, approvedBy: null }),
    );
    expect(withTenant("globex", (s) => getPayrollRun(s, runId)?.tenantId)).toBe("globex");
    expect(withTenant("acme", (s) => getPayrollRun(s, runId))).toBeUndefined();
  });

  it("rejects malformed tenant ids before touching the database", () => {
    for (const bad of ["", "ACME", "acme' OR '1'='1", "../globex", "a", "acme globex"]) {
      expect(() => withTenant(bad, () => 0)).toThrow(/Invalid tenant id/);
    }
  });
});
