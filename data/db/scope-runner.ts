import "server-only";
import { getConnection, type Transaction } from "./connection";
import { enterScope, exitScope, type ActiveScope } from "./scope-state";

/** Rejects callbacks that return a promise: the scope must open, run, and close with no await inside. */
export type Sync<T> = T extends PromiseLike<unknown> ? never : T;

export interface Revocable {
  revoke(): void;
}

function isThenable(value: unknown): value is PromiseLike<unknown> {
  return typeof value === "object" && value !== null && typeof (value as { then?: unknown }).then === "function";
}

// Sets the connection's scope, runs the callback inside one synchronous transaction, then clears the scope
// and revokes the scope object. better-sqlite3 is synchronous and JavaScript runs one block at a time, so no
// other request can run between setting and clearing the scope. A callback that returns a promise is rolled
// back and rejected, because anything after its first await would run after the scope has closed.
export function runScoped<S extends Revocable, T>(
  state: ActiveScope,
  makeScope: (tx: Transaction) => S,
  fn: (scope: S) => T,
): T {
  const { db, scope: holder } = getConnection();
  enterScope(holder, state);
  let scope: S | undefined;
  try {
    return db.transaction((tx) => {
      scope = makeScope(tx);
      const result = fn(scope);
      if (isThenable(result)) {
        // Keep the abandoned promise from surfacing as an unhandled rejection; the throw below reports the misuse.
        Promise.resolve(result).catch(() => {});
        throw new Error("Database scope callbacks must be synchronous (no async/await); the transaction was rolled back");
      }
      return result;
    });
  } finally {
    scope?.revoke();
    exitScope(holder);
  }
}
