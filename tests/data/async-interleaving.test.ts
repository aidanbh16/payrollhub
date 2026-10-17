import { randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { describe, expect, it, vi } from "vitest";
import { withTenant, type TenantScope } from "@/data/db/tenant-scope";
import { insertPayrollRun, listEmployees, listPayrollRuns } from "@/services/engine/repository";
import { listUsers } from "@/services/identity/repository";
import { idsFor, rawSqlite, setupSeededDatabase } from "../helpers/database";

// current_tenant() is per-connection state. These tests show it can never leak between concurrent requests:
// the scope opens, runs, and closes in one synchronous block, and anything that would break that rule is refused.

setupSeededDatabase();

const currentTenant = () => (rawSqlite().prepare("SELECT current_tenant() AS t").get() as { t: string | null }).t;

async function simulatedRequest(tenantId: string, rounds: number): Promise<string[]> {
  const seen: string[] = [];
  for (let i = 0; i < rounds; i++) {
    await sleep(Math.random() * 3);
    seen.push(...withTenant(tenantId, (s) => [...listUsers(s), ...listEmployees(s)].map((row) => row.tenantId)));
    await sleep(Math.random() * 3);
  }
  return seen;
}

describe("[L1-14] [L2-16] tenant context under concurrency", () => {
  it("interleaved async requests for different tenants never see each other's rows", async () => {
    const tenants = Array.from({ length: 20 }, (_, i) => (i % 2 === 0 ? "acme" : "globex"));
    const results = await Promise.all(tenants.map((t) => simulatedRequest(t, 15)));
    results.forEach((seen, i) => {
      expect(seen.length).toBe(15 * 8);
      expect(new Set(seen)).toEqual(new Set([tenants[i]]));
    });
    expect(currentTenant()).toBeNull();
  });

  it("an async callback is rejected and its writes are rolled back", async () => {
    const { hrAdminId } = idsFor("acme");
    const before = withTenant("acme", (s) => listPayrollRuns(s).length);
    const run = () => ({ runId: randomUUID(), payDate: "2026-12-11", status: "draft" as const, createdBy: hrAdminId, approvedBy: null });

    expect(() =>
      withTenant("acme", (async (s: TenantScope) => {
        insertPayrollRun(s, run());
        await sleep(1);
        insertPayrollRun(s, run()); // would run after the scope closed; the revoked scope throws instead
      }) as never),
    ).toThrow(/must be synchronous/);

    await sleep(10); // let the abandoned continuation run and fail against the revoked scope
    expect(withTenant("acme", (s) => listPayrollRuns(s).length)).toBe(before);
    expect(currentTenant()).toBeNull();
  });

  it("a scope object that escapes its block cannot be used again", () => {
    let leaked: TenantScope | undefined;
    withTenant("acme", (s) => {
      leaked = s;
      return 0;
    });
    expect(() => listEmployees(leaked!)).toThrow(/after its withTenant block ended/);
    withTenant("globex", () => {
      expect(() => listEmployees(leaked!)).toThrow(/after its withTenant block ended/);
    });
  });

  it("scopes cannot be nested, and the tenant is cleared even when the block throws", () => {
    expect(() => withTenant("acme", () => withTenant("globex", () => 0))).toThrow(/cannot be nested/);
    expect(currentTenant()).toBeNull();
    expect(() =>
      withTenant("acme", () => {
        throw new Error("boom");
      }),
    ).toThrow("boom");
    expect(currentTenant()).toBeNull();
  });

  it("a second copy of the data modules (as Next.js bundles create) shares the connection's tenant context", async () => {
    // Next.js bundles pages and route handlers separately, so tenant-scope can be loaded twice while both copies use
    // the one connection on globalThis. Both copies must drive the same current_tenant().
    vi.resetModules();
    const fresh = await import("@/data/db/tenant-scope");
    const freshEngine = await import("@/services/engine/repository");
    expect(fresh.withTenant).not.toBe(withTenant); // really a separate module instance
    expect(fresh.withTenant("acme", (s) => freshEngine.listEmployees(s).map((e) => e.tenantId))).toEqual(["acme", "acme", "acme"]);
    expect(withTenant("globex", (s) => listEmployees(s).map((e) => e.tenantId))).toEqual(["globex", "globex", "globex"]);
    expect(() => fresh.withTenant("acme", () => withTenant("globex", () => 0))).toThrow(/cannot be nested/);
    expect(currentTenant()).toBeNull();
  });

  it("async callbacks are also rejected at compile time (checked by tsc --noEmit)", () => {
    // Never called: tsc fails if withTenant ever starts accepting an async callback.
    const compileTimeOnly = () => {
      // @ts-expect-error async callbacks are not allowed
      withTenant("acme", async (s) => listEmployees(s));
    };
    expect(typeof compileTimeOnly).toBe("function");
  });
});
