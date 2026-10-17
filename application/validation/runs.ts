import { z } from "zod";
import { uuidParam } from "./common";

// Payroll run inputs. Strict: an unknown field (including tenantId) is rejected, never silently dropped.
export const createRunBody = z.strictObject({
  payDate: z.iso.date(),
});

export const runParams = z.strictObject({
  runId: uuidParam,
});

export const updateRunBody = z.strictObject({
  payDate: z.iso.date(),
});

export const approveRunBody = z.strictObject({
  code: z.string().trim().max(12),
});

/** Starting a run takes the approval token and nothing else: no amounts, employees, or accounts are accepted. */
export const startRunBody = z.strictObject({
  approvalToken: z.string().max(4096),
});

/** "Send to bank" carries nothing: amounts, employees, and accounts all come from the run's pay results. */
export const disburseBody = z.strictObject({});

/** An employee's own pay statement, by pay result id. */
export const statementParams = z.strictObject({ resultId: uuidParam });
