import "server-only";
import type { InferInsertModel } from "drizzle-orm";
import type { Transaction } from "./connection";
import { runScoped, type Sync } from "./scope-runner";
import * as tables from "./tables";
import { vServiceGrant } from "./views";

// Platform-level data with no tenant: ServiceGrant (Assignment 5, Section 3.1). Section 3.1 makes it readable only
// by Identity & Access, so ESLint allows this module only in services/identity/ and scripts/. The database
// enforces the same rule: v_service_grant is empty and the triggers reject writes outside a platform scope.

export class PlatformScope {
  #tx: Transaction | null;

  constructor(tx: Transaction) {
    this.#tx = tx;
  }

  #live(): Transaction {
    if (!this.#tx) throw new Error("Platform scope used after its withPlatform block ended");
    return this.#tx;
  }

  readServiceGrants() {
    return this.#live().select().from(vServiceGrant);
  }

  insertServiceGrant(values: InferInsertModel<typeof tables.serviceGrant>): number {
    return this.#live().insert(tables.serviceGrant).values(values).run().changes;
  }

  revoke(): void {
    this.#tx = null;
  }
}

export function withPlatform<T>(fn: (scope: PlatformScope) => Sync<T>): Sync<T> {
  return runScoped({ kind: "platform" }, (tx) => new PlatformScope(tx), fn);
}
