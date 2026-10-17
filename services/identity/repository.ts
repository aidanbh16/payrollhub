import "server-only";
import { and, eq, isNull, lt, or } from "drizzle-orm";
import { decryptField, encryptField, fieldContext } from "@/data/crypto/field-encryption";
import type { PlatformScope } from "@/data/db/platform-scope";
import type { TenantInsert, TenantScope } from "@/data/db/tenant-scope";
import { vAppUser, vServiceTokenUse, vSession, vSsoAssertion, vTenant, vTenantIdpConfig } from "@/data/db/views";

// Identity & Access repository (Section 3.1): tenant, users, sessions, IdP config, and service grants.

export function getTenant(s: TenantScope) {
  return s.read(vTenant).get();
}

export function insertTenant(s: TenantScope, values: TenantInsert<"tenant">) {
  s.insert("tenant", values);
}

export type NewUser = Omit<TenantInsert<"appUser">, "totpSecret"> & { totpSecret?: string };

export function insertUser(s: TenantScope, { totpSecret, ...user }: NewUser) {
  s.insert("appUser", {
    ...user,
    totpSecret: totpSecret ? encryptField(totpSecret, fieldContext(s.tenantId, "app_user.totp_secret", user.userId)) : null,
  });
}

export function findUserByEmail(s: TenantScope, email: string) {
  return s.read(vAppUser).where(eq(vAppUser.email, email)).get();
}

export function findUserBySsoSubject(s: TenantScope, ssoSubject: string) {
  return s.read(vAppUser).where(eq(vAppUser.ssoSubject, ssoSubject)).get();
}

/**
 * Records the TOTP time step a user just used, in one atomic UPDATE that succeeds only if the step is newer than the
 * last one accepted. Returns false for a replayed code, even if two requests race with the same code.
 */
export function recordTotpStep(s: TenantScope, userId: string, step: number): boolean {
  const changed = s.update("appUser", { totpLastUsedStep: step }, (t) =>
    and(eq(t.userId, userId), or(isNull(t.totpLastUsedStep), lt(t.totpLastUsedStep, step))),
  );
  return changed === 1;
}

export function getUser(s: TenantScope, userId: string) {
  return s.read(vAppUser).where(eq(vAppUser.userId, userId)).get();
}

export function listUsers(s: TenantScope) {
  return s.read(vAppUser).all();
}

export function getTotpSecret(s: TenantScope, userId: string): string | null {
  const user = getUser(s, userId);
  if (!user?.totpSecret) return null;
  return decryptField(user.totpSecret, fieldContext(s.tenantId, "app_user.totp_secret", userId));
}

export function insertSession(s: TenantScope, values: TenantInsert<"session">) {
  s.insert("session", values);
}

export function findSession(s: TenantScope, sessionId: string) {
  return s.read(vSession).where(eq(vSession.sessionId, sessionId)).get();
}

/** Sets revoked_at on a live session. Returns false if it was already revoked or does not exist. */
export function revokeSession(s: TenantScope, sessionId: string, now: Date): boolean {
  return s.update("session", { revokedAt: now }, (t) => and(eq(t.sessionId, sessionId), isNull(t.revokedAt))) === 1;
}

export function getIdpConfig(s: TenantScope) {
  return s.read(vTenantIdpConfig).get();
}

export function insertIdpConfig(s: TenantScope, values: TenantInsert<"tenantIdpConfig">) {
  s.insert("tenantIdpConfig", values);
}

export function findAssertionUse(s: TenantScope, assertionId: string) {
  return s.read(vSsoAssertion).where(eq(vSsoAssertion.assertionId, assertionId)).get();
}

/**
 * Records an SSO assertion id as used and returns true, or returns false if it was already used (a replay).
 * Records are kept until the assertion could no longer pass validation, then purged. The primary key makes the
 * insert itself the final check, so two requests racing with the same assertion cannot both succeed.
 */
export function recordAssertionUse(s: TenantScope, assertionId: string, keepUntil: Date, now: Date): boolean {
  s.delete("ssoAssertion", (t) => lt(t.expiresAt, now));
  if (findAssertionUse(s, assertionId)) return false;
  try {
    s.insert("ssoAssertion", { assertionId, expiresAt: keepUntil });
    return true;
  } catch (err) {
    if ((err as { code?: string }).code === "SQLITE_CONSTRAINT_PRIMARYKEY") return false;
    throw err;
  }
}

/** Single-use service tokens: same pattern as recordAssertionUse. Returns false if the token id was already used. */
export function recordServiceTokenUse(s: TenantScope, tokenId: string, keepUntil: Date, now: Date): boolean {
  s.delete("serviceTokenUse", (t) => lt(t.expiresAt, now));
  if (s.read(vServiceTokenUse).where(eq(vServiceTokenUse.tokenId, tokenId)).get()) return false;
  try {
    s.insert("serviceTokenUse", { tokenId, expiresAt: keepUntil });
    return true;
  } catch (err) {
    if ((err as { code?: string }).code === "SQLITE_CONSTRAINT_PRIMARYKEY") return false;
    throw err;
  }
}

export function listServiceGrants(p: PlatformScope) {
  return p.readServiceGrants().all();
}

export function insertServiceGrant(p: PlatformScope, values: Parameters<PlatformScope["insertServiceGrant"]>[0]) {
  p.insertServiceGrant(values);
}
