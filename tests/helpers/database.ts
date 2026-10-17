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

let payDates = 0;
/**
 * A pay date no other run in this test file has used: 2027-06-04, then a week later each call (clear of the dates tests
 * write literally). A tenant can have only one live run per pay date (RT-01), so fixtures that create several runs need
 * distinct dates.
 */
export function nextPayDate(): string {
  const date = new Date(Date.UTC(2027, 5, 4 + 7 * payDates++));
  return date.toISOString().slice(0, 10);
}
