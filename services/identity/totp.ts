import "server-only";
import { verifySync } from "otplib";
import type { TenantScope } from "@/data/db/tenant-scope";
import { getTotpSecret, getUser, recordTotpStep } from "./repository";

const CODE = /^\d{6}$/;
// Accept one 30-second step either side of the server clock for authenticator drift.
const TOLERANCE_SECONDS = 30;

/**
 * Verifies a TOTP code and marks its time step used, inside the caller's tenant scope.
 * A code is accepted at most once: otplib rejects steps at or before the last accepted one, and the atomic
 * recordTotpStep() update rejects a second request that raced past that check with the same code.
 */
export function consumeTotpCode(s: TenantScope, userId: string, code: string, now: Date): boolean {
  if (!CODE.test(code)) return false;
  const user = getUser(s, userId);
  const secret = getTotpSecret(s, userId);
  if (!user || !secret) return false;
  const result = verifySync({
    secret,
    token: code,
    epoch: Math.floor(now.getTime() / 1000),
    epochTolerance: TOLERANCE_SECONDS,
    afterTimeStep: user.totpLastUsedStep ?? undefined,
  });
  // verifySync's result type also covers HOTP; a TOTP result always carries the matched time step.
  if (!result.valid || !("timeStep" in result)) return false;
  return recordTotpStep(s, userId, result.timeStep);
}
