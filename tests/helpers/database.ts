import { afterAll, beforeAll } from "vitest";
import { getConnection } from "@/data/db/connection";
import { deleteDatabase, migrateDatabase } from "@/data/db/migrate";
import { withTenant } from "@/data/db/tenant-scope";
import { listEmployees } from "@/services/engine/repository";
import { listUsers } from "@/services/identity/repository";
import { seedDatabase } from "@/scripts/lib/seed";

/** Fresh migrated and seeded database for the test file, deleted afterwards. */
export function setupSeededDatabase(): void {
  beforeAll(async () => {
    deleteDatabase();
    migrateDatabase();
    await seedDatabase();
  });
  afterAll(() => deleteDatabase());
}

/** The raw better-sqlite3 handle: lets a test bypass the repository entirely. Application code cannot import it. */
export function rawSqlite() {
  return getConnection().sqlite;
}

export function idsFor(tenantId: string) {
  return withTenant(tenantId, (s) => ({
    userIds: listUsers(s).map((u) => u.userId),
    employeeIds: listEmployees(s).map((e) => e.employeeId),
    hrAdminId: listUsers(s).find((u) => u.role === "hr_admin")!.userId,
  }));
}
