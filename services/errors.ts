// Errors that backend services throw. The route wrapper (application/http/route.ts) turns each one into a fixed,
// generic response; no message from any other error ever reaches a client.

/** A service call without a valid scoped token. The reason is for server logs only; clients see a generic 401. */
export class ServiceAuthError extends Error {
  constructor(readonly reason: string) {
    super(`Service authentication failed: ${reason}`);
  }
}

/** The resource does not exist in the caller's tenant. Used for both "missing" and "belongs to another tenant". */
export class NotFoundError extends Error {
  constructor() {
    super("Not found");
  }
}

/** The input was well-formed but not acceptable. The message is written for clients and must not contain data. */
export class InvalidInputError extends Error {}

/** The action conflicts with the resource's state (e.g. approving a run that is not a draft). Message is client-safe. */
export class ConflictError extends Error {}

/** A money-moving action without a fresh MFA step-up. */
export class StepUpRequiredError extends Error {
  constructor() {
    super("Fresh MFA step-up required");
  }
}

/** An approval token that is invalid, expired, retired, replayed, or for a different tenant or run. Never says which. */
export class ApprovalRejectedError extends Error {
  constructor(readonly reason: string) {
    super(`Approval token rejected: ${reason}`);
  }
}

/**
 * A payroll run that could not be computed. The run is now `failed` and needs re-approval; nothing was paid and no
 * partial results exist. `reason` is a fixed code, safe to show.
 */
export class RunFailedError extends Error {
  constructor(readonly reason: "content_changed" | "computation_error" | "bank_account_changed") {
    super(`Payroll run failed (${reason}); it needs to be approved again`);
  }
}

/** The bank refused a batch (bad signature, unknown key, malformed file). `reason` is the bank's fixed reason code. */
export class BankRejectedError extends Error {
  constructor(readonly reason: string) {
    super(`The bank rejected the ACH batch: ${reason}`);
  }
}

/** The bank could not be reached or did not answer in time. Sending again resends the same signed batch. */
export class BankUnavailableError extends Error {
  constructor(readonly reason: string) {
    super(`The bank did not answer: ${reason}`);
  }
}
