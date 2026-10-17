import "server-only";
import { withTenant } from "@/data/db/tenant-scope";
import { findSession, revokeSession } from "./repository";
import { TTL, createSession, isPrivilegedRole, type SessionClaims } from "./sessions";
import { consumeTotpCode } from "./totp";

// Approval-time MFA step-up (Assignment 5, Sections 2.1 and 2.4). Payroll Approval issues an approval token only with a
// StepUpProof from a successful stepUp(). A successful step-up also replaces the session with a new id, so the session
// that existed before the step-up cannot be reused.

/** Proof that this user just passed a fresh TOTP step-up. Only this module can create one, and it can be used once. */
export interface StepUpProof {
  readonly userId: string;
  readonly tenantId: string;
  readonly at: Date;
}

export interface StepUpResult {
  /** New session cookie value; the caller must set it on the response. */
  cookie: string;
  stepUpAt: Date;
  proof: StepUpProof;
}

/** How long a proof stays usable: long enough for the approval request that produced it, no longer. */
const PROOF_TTL_MS = 60_000;

// Proofs created by stepUp() in this module and not yet used. Nothing outside this module can add one.
const liveProofs = new WeakSet<StepUpProof>();

export function stepUp(
  current: SessionClaims,
  input: { code: string; deviceId: string | undefined },
  now = new Date(),
): StepUpResult | null {
  if (!isPrivilegedRole(current.role) || !current.mfaVerifiedAt || !input.deviceId) return null;
  const deviceId = input.deviceId;
  return withTenant(current.tenantId, (s) => {
    // Re-check inside this transaction: the session may have been revoked since the request was authenticated.
    const live = findSession(s, current.sessionId);
    if (!live || live.revokedAt || live.expiresAt.getTime() <= now.getTime()) return null;
    if (!consumeTotpCode(s, current.userId, input.code, now)) return null;
    revokeSession(s, current.sessionId, now);
    const cookie = createSession(s, { userId: current.userId, deviceId, mfaVerifiedAt: now, ttlMs: TTL.privileged, now });
    const proof: StepUpProof = Object.freeze({ userId: current.userId, tenantId: current.tenantId, at: now });
    liveProofs.add(proof);
    return { cookie, stepUpAt: now, proof };
  });
}

/**
 * Accepts a step-up proof once: it must come from stepUp() in this process, belong to this user and tenant, and be at
 * most 60 seconds old. A hand-built object, a reused proof, or someone else's proof is refused.
 */
export function consumeStepUpProof(proof: StepUpProof | undefined, expected: { userId: string; tenantId: string }, now = new Date()): boolean {
  if (!proof || !liveProofs.has(proof)) return false;
  liveProofs.delete(proof);
  const age = now.getTime() - proof.at.getTime();
  return proof.userId === expected.userId && proof.tenantId === expected.tenantId && age >= 0 && age <= PROOF_TTL_MS;
}
