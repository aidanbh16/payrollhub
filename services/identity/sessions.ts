import "server-only";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { withTenant, type TenantScope } from "@/data/db/tenant-scope";
import { findSession, getUser, insertSession, revokeSession } from "./repository";

// Server-side sessions stored in the Session table (D3; Assignment 5, Sections 2.1 and 3.1).
// The cookie holds "<tenantId>.<random token>"; the table stores only the token's SHA-256 hash, so a database
// leak does not reveal usable session cookies. Each session is bound to the device cookie it was created with.

export type Role = "hr_admin" | "approver" | "employee";

export const TTL = {
  /** Between a correct password and the TOTP step. */
  pendingMfa: 5 * 60_000,
  /** HR Admin and Payroll Approver: short, because these sessions can move money. */
  privileged: 30 * 60_000,
  employee: 60 * 60_000,
} as const;

export function isPrivilegedRole(role: Role): boolean {
  return role === "hr_admin" || role === "approver";
}

export interface SessionClaims {
  tenantId: string;
  userId: string;
  email: string;
  role: Role;
  /** SHA-256 of the cookie token: the Session table's primary key. */
  sessionId: string;
  mfaVerifiedAt: Date | null;
  expiresAt: Date;
}

const TENANT_ID = /^[a-z][a-z0-9-]{1,39}$/;
const TOKEN = /^[A-Za-z0-9_-]{43}$/;

export const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");
export const randomToken = () => randomBytes(32).toString("base64url");
export const isWellFormedToken = (value: string | undefined): value is string => !!value && TOKEN.test(value);

export function sessionCookieValue(tenantId: string, token: string): string {
  return `${tenantId}.${token}`;
}

export function parseSessionCookie(value: string | undefined): { tenantId: string; token: string } | null {
  if (!value) return null;
  const dot = value.indexOf(".");
  const tenantId = value.slice(0, dot);
  const token = value.slice(dot + 1);
  if (dot < 0 || !TENANT_ID.test(tenantId) || !TOKEN.test(token)) return null;
  return { tenantId, token };
}

function sameHash(a: string, b: string): boolean {
  return a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

/** Creates a session inside the caller's tenant scope with a brand-new random id, and returns the cookie value. */
export function createSession(
  s: TenantScope,
  opts: { userId: string; deviceId: string; mfaVerifiedAt: Date | null; ttlMs: number; now: Date },
): string {
  const token = randomToken();
  insertSession(s, {
    sessionId: sha256(token),
    userId: opts.userId,
    deviceBinding: sha256(opts.deviceId),
    mfaVerifiedAt: opts.mfaVerifiedAt,
    expiresAt: new Date(opts.now.getTime() + opts.ttlMs),
    revokedAt: null,
  });
  return sessionCookieValue(s.tenantId, token);
}

/** A session is valid only if it exists, is not revoked or expired, matches this device, and its user is active. */
export function loadSession(s: TenantScope, token: string, deviceId: string | undefined, now: Date): SessionClaims | null {
  const row = findSession(s, sha256(token));
  if (!row || row.revokedAt || row.expiresAt.getTime() <= now.getTime()) return null;
  if (!isWellFormedToken(deviceId) || !sameHash(row.deviceBinding, sha256(deviceId))) return null;
  const user = getUser(s, row.userId);
  if (!user || user.status !== "active") return null;
  return {
    tenantId: s.tenantId,
    userId: user.userId,
    email: user.email,
    role: user.role,
    sessionId: row.sessionId,
    mfaVerifiedAt: row.mfaVerifiedAt,
    expiresAt: row.expiresAt,
  };
}

/** Looks a session cookie up in the Session table. Returns null for anything that is not a live session. */
export function readSession(cookie: string | undefined, deviceId: string | undefined, now = new Date()): SessionClaims | null {
  const parsed = parseSessionCookie(cookie);
  if (!parsed) return null;
  return withTenant(parsed.tenantId, (s) => loadSession(s, parsed.token, deviceId, now));
}

/** Logout and session replacement: sets revoked_at, which ends the session on its very next request. */
export function revokeSessionCookie(cookie: string | undefined, now = new Date()): boolean {
  const parsed = parseSessionCookie(cookie);
  if (!parsed) return false;
  return withTenant(parsed.tenantId, (s) => revokeSession(s, sha256(parsed.token), now));
}
