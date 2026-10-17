import "server-only";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { env } from "@/config/env";
import { closeConnection, getConnection } from "./connection";

// Applies migrations/ in order: the drizzle-kit generated tables, then the hand-written isolation views and triggers.
export function migrateDatabase(): void {
  migrate(getConnection().db, { migrationsFolder: join(process.cwd(), "migrations") });
}

/** Deletes the database file and its WAL files. Used by db:reset and tests to start from a clean state. */
export function deleteDatabase(): void {
  closeConnection();
  const path = env().DATABASE_PATH;
  if (path === ":memory:") return;
  for (const suffix of ["", "-wal", "-shm"]) rmSync(path + suffix, { force: true });
}
