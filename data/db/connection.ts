import "server-only";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { env } from "@/config/env";
import type { ScopeHolder } from "./scope-state";

// The only place the database is opened. ESLint keeps this module inside data/db/; application code
// reaches the database only through withTenant() in tenant-scope.ts.

type StatementObserver = (statement: string) => void;
const observers = new Set<StatementObserver>();

/** Sees every SQL statement executed on the connection. Used by tests to prove reads hit only views. */
export function observeStatements(observer: StatementObserver): () => void {
  observers.add(observer);
  return () => observers.delete(observer);
}

function open() {
  const path = env().DATABASE_PATH;
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });

  const sqlite = new Database(path, {
    verbose: (message) => observers.forEach((observe) => observe(String(message))),
  });
  sqlite.pragma("journal_mode = WAL");
  sqlite.pragma("foreign_keys = ON");
  sqlite.pragma("busy_timeout = 5000");
  // The isolation views and triggers call app-defined functions, which SQLite allows only while
  // trusted_schema is ON (the default). Refuse to start rather than run with isolation broken.
  if (sqlite.pragma("trusted_schema", { simple: true }) !== 1) {
    throw new Error("SQLite trusted_schema must be ON for the tenant-isolation views and triggers");
  }

  // Per-connection tenant context: the SQLite equivalent of PostgreSQL's current_setting() under RLS.
  // NULL outside a tenant scope, so the views return nothing and the triggers reject every write.
  const scope: ScopeHolder = { active: null };
  sqlite.function("current_tenant", { deterministic: false }, () => (scope.active?.kind === "tenant" ? scope.active.tenantId : null));
  sqlite.function("in_platform_scope", { deterministic: false }, () => (scope.active?.kind === "platform" ? 1 : 0));

  return { sqlite, db: drizzle({ client: sqlite }), scope };
}

type Connection = ReturnType<typeof open>;
const globalForDb = globalThis as unknown as { payrollhubDb?: Connection };

export function getConnection(): Connection {
  globalForDb.payrollhubDb ??= open();
  return globalForDb.payrollhubDb;
}

export function closeConnection(): void {
  globalForDb.payrollhubDb?.sqlite.close();
  globalForDb.payrollhubDb = undefined;
}

export type Transaction = Parameters<Parameters<Connection["db"]["transaction"]>[0]>[0];
