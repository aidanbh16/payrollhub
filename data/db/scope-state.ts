// The connection's current scope, read by the SQL functions current_tenant() and in_platform_scope().
// The holder belongs to the connection object (see connection.ts), not to this module: Next.js bundles pages and
// route handlers separately, so this module can be loaded more than once while all copies share one connection.
// Keeping the state on the connection means every copy sets and reads the same value.
// It is set and cleared only by runScoped() in scope-runner.ts, inside one synchronous block.
export type ActiveScope = { kind: "tenant"; tenantId: string } | { kind: "platform" };

export interface ScopeHolder {
  active: ActiveScope | null;
}

export function enterScope(holder: ScopeHolder, scope: ActiveScope): void {
  if (holder.active) throw new Error("Database scopes cannot be nested");
  holder.active = scope;
}

export function exitScope(holder: ScopeHolder): void {
  holder.active = null;
}
