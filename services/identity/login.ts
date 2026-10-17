import "server-only";
import { withTenant } from "@/data/db/tenant-scope";
import { dummyPasswordHash, verifyPassword } from "./password";
import { findUserByEmail, revokeSession } from "./repository";
import {
  TTL, createSession, isPrivilegedRole, loadSession, parseSessionCookie, randomToken, sessionCookieValue, type Role,
} from "./sessions";
import { consumeTotpCode } from "./totp";

// Staff sign-in for HR Admins and Payroll Approvers (Assignment 5, Section 2.3): password, then a required TOTP code.
//
// Step 1 never says whether the password was right. It always answers "enter your code" and always sets a session
// cookie, but a real (pending) session exists only if the organization, email, and password were all correct. Every
// path runs one scrypt verification, so timing does not reveal which part was wrong. Step 2 fails with the same
// generic message whether the pending session was fake, expired, or the code was wrong.


const TENANT_ID = /^[a-z][a-z0-9-]{1,39}$/;

// Compute the dummy hash at startup so the first failed login is not slower than the rest.
void dummyPasswordHash();

export interface StaffLoginInput {
  organization: string;
  email: string;
  password: string;
  deviceId: string;
}

/** Step 1. Returns a session cookie value for the MFA step; it is real only if the credentials were correct. */
export async function startStaffLogin(input: StaffLoginInput, now = new Date()): Promise<string> {
  const tenantOk = TENANT_ID.test(input.organization);
  const user = tenantOk ? withTenant(input.organization, (s) => findUserByEmail(s, input.email)) : undefined;
  const candidate = user && user.status === "active" && isPrivilegedRole(user.role) && user.passwordHash ? user : undefined;

  const passwordOk = await verifyPassword(input.password, candidate?.passwordHash ?? (await dummyPasswordHash()));

  if (candidate && passwordOk) {
    return withTenant(input.organization, (s) =>
      createSession(s, { userId: candidate.userId, deviceId: input.deviceId, mfaVerifiedAt: null, ttlMs: TTL.pendingMfa, now }),
    );
  }
  // Same shape as a real cookie, but nothing is stored, so the code step can only fail.
  return sessionCookieValue(tenantOk ? input.organization : "unknown", randomToken());
}

/**
 * Step 2. Exchanges a pending session and a TOTP code for a new, MFA-verified session with a new id.
 * The pending session is spent either way: one code attempt per password entry.
 */
export function completeStaffLogin(
  input: { pendingCookie: string | undefined; deviceId: string | undefined; code: string },
  now = new Date(),
): { cookie: string; role: Role; tenantId: string; email: string } | null {
  const parsed = parseSessionCookie(input.pendingCookie);
  if (!parsed) return null;
  return withTenant(parsed.tenantId, (s) => {
    const pending = loadSession(s, parsed.token, input.deviceId, now);
    if (!pending || pending.mfaVerifiedAt || !isPrivilegedRole(pending.role) || !input.deviceId) return null;
    revokeSession(s, pending.sessionId, now);
    if (!consumeTotpCode(s, pending.userId, input.code, now)) return null;
    const cookie = createSession(s, { userId: pending.userId, deviceId: input.deviceId, mfaVerifiedAt: now, ttlMs: TTL.privileged, now });
    return { cookie, role: pending.role, tenantId: pending.tenantId, email: pending.email };
  });
}
