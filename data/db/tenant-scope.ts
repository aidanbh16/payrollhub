import "server-only";
import { and, eq, type InferInsertModel, type SQL } from "drizzle-orm";
import type { Transaction } from "./connection";
import { runScoped, type Sync } from "./scope-runner";
import * as tables from "./tables";
import * as views from "./views";

// The tenant-scoped repository core. withTenant() is the only way application code reaches the database:
//  - reads go through read(view), which accepts only the tenant-filtered views, never a base table;
//  - writes name a table, and the scope fills tenant_id itself, so callers cannot choose a tenant (L2-04);
//  - update and delete always add "tenant_id = <scope tenant>" to the caller's condition;
//  - the database triggers reject any write whose tenant does not match current_tenant() (L2-16).

const TENANT_TABLES = {
  tenant: tables.tenant,
  appUser: tables.appUser,
  session: tables.session,
  tenantIdpConfig: tables.tenantIdpConfig,
  employee: tables.employee,
  payrollRun: tables.payrollRun,
  approvalToken: tables.approvalToken,
  payResult: tables.payResult,
  bankAccount: tables.bankAccount,
  bankAccountChange: tables.bankAccountChange,
  verificationCode: tables.verificationCode,
  achBatch: tables.achBatch,
  ssoAssertion: tables.ssoAssertion,
  serviceTokenUse: tables.serviceTokenUse,
  payException: tables.payException,
} as const;

export type TenantTableName = keyof typeof TENANT_TABLES;
type TableOf<K extends TenantTableName> = (typeof TENANT_TABLES)[K];
// A mapped type rather than Omit: Omit drops the optional (nullable) columns from drizzle's insert type.
type WithoutTenant<T> = { [P in keyof T as P extends "tenantId" ? never : P]: T[P] };
export type TenantInsert<K extends TenantTableName> = WithoutTenant<InferInsertModel<TableOf<K>>>;
export type TenantUpdate<K extends TenantTableName> = Partial<TenantInsert<K>>;

export type TenantView =
  | typeof views.vTenant
  | typeof views.vAppUser
  | typeof views.vSession
  | typeof views.vTenantIdpConfig
  | typeof views.vEmployee
  | typeof views.vPayrollRun
  | typeof views.vApprovalToken
  | typeof views.vPayResult
  | typeof views.vBankAccount
  | typeof views.vBankAccountChange
  | typeof views.vVerificationCode
  | typeof views.vAchBatch
  | typeof views.vSsoAssertion
  | typeof views.vServiceTokenUse
  | typeof views.vPayException;

const TENANT_VIEWS: ReadonlySet<unknown> = new Set<TenantView>([
  views.vTenant,
  views.vAppUser,
  views.vSession,
  views.vTenantIdpConfig,
  views.vEmployee,
  views.vPayrollRun,
  views.vApprovalToken,
  views.vPayResult,
  views.vBankAccount,
  views.vBankAccountChange,
  views.vVerificationCode,
  views.vAchBatch,
  views.vSsoAssertion,
  views.vServiceTokenUse,
  views.vPayException,
]);

// Every tenant table has a tenantId column; this narrowed type lets the scope build its predicates generically.
type AnyTenantTable = typeof tables.employee;

const TENANT_ID = /^[a-z][a-z0-9-]{1,39}$/;

function rejectCallerTenant(values: object): void {
  if ("tenantId" in values) throw new Error("tenantId is set by the tenant scope, not by the caller");
}

export class TenantScope {
  #tx: Transaction | null;

  constructor(
    readonly tenantId: string,
    tx: Transaction,
  ) {
    this.#tx = tx;
  }

  #live(): Transaction {
    if (!this.#tx) throw new Error("Tenant scope used after its withTenant block ended");
    return this.#tx;
  }

  /** Select from a tenant-filtered view. Base tables are not accepted. */
  read<V extends TenantView>(view: V) {
    // The type already rejects base tables; this also stops a cast from slipping one through.
    if (!TENANT_VIEWS.has(view)) throw new Error("Tenant scopes read only from the tenant-filtered views");
    return this.#live().select().from(view);
  }

  insert<K extends TenantTableName>(table: K, values: TenantInsert<K> | TenantInsert<K>[]): number {
    const rows = Array.isArray(values) ? values : [values];
    rows.forEach(rejectCallerTenant);
    const target = TENANT_TABLES[table] as AnyTenantTable;
    const scoped = rows.map((row) => ({ ...row, tenantId: this.tenantId }));
    return this.#live().insert(target).values(scoped as never).run().changes;
  }

  update<K extends TenantTableName>(
    table: K,
    values: TenantUpdate<K>,
    where: (t: TableOf<K>) => SQL | undefined,
  ): number {
    rejectCallerTenant(values);
    const target = TENANT_TABLES[table] as AnyTenantTable;
    return this.#live()
      .update(target)
      .set(values as never)
      .where(and(eq(target.tenantId, this.tenantId), where(TENANT_TABLES[table])))
      .run().changes;
  }

  delete<K extends TenantTableName>(table: K, where: (t: TableOf<K>) => SQL | undefined): number {
    const target = TENANT_TABLES[table] as AnyTenantTable;
    return this.#live()
      .delete(target)
      .where(and(eq(target.tenantId, this.tenantId), where(TENANT_TABLES[table])))
      .run().changes;
  }

  revoke(): void {
    this.#tx = null;
  }
}

/**
 * Runs fn with the database scoped to one tenant, inside one synchronous transaction.
 * The tenantId must come from verified claims, never from request input.
 */
export function withTenant<T>(tenantId: string, fn: (scope: TenantScope) => Sync<T>): Sync<T> {
  if (!TENANT_ID.test(tenantId)) throw new Error("Invalid tenant id");
  return runScoped({ kind: "tenant", tenantId }, (tx) => new TenantScope(tenantId, tx), fn);
}
