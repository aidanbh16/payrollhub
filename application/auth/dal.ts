import "server-only";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { connection } from "next/server";
import { isPrivilegedRole, readSession, type Role, type SessionClaims } from "@/services/identity/sessions";
import { DEVICE_COOKIE, SESSION_COOKIE } from "./cookie-names";

// Data Access Layer (D2; Assignment 5, Section 2.3). Proxy only checks that a session cookie exists; this is the
// authoritative check, and every page and route handler calls it. It looks the session up in the Session table on
// every request, so a revoked or expired session stops working on its next request.

interface CookieReader {
  get(name: string): { value: string } | undefined;
}

export class AuthError extends Error {
  constructor(readonly status: 401 | 403) {
    super(status === 401 ? "Not signed in" : "Not allowed");
  }
}

export function verifySession(store: CookieReader, now = new Date()): SessionClaims | null {
  const claims = readSession(store.get(SESSION_COOKIE)?.value, store.get(DEVICE_COOKIE)?.value, now);
  if (!claims) return null;
  // Required MFA (L0-01): an HR Admin or Payroll Approver session counts only once its TOTP step is complete.
  // This is not configurable per route, so no admin or approver route can opt out.
  if (isPrivilegedRole(claims.role) && !claims.mfaVerifiedAt) return null;
  return claims;
}

/** For route handlers: returns the verified claims or throws AuthError (401 not signed in, 403 wrong role). */
export function requireSession(store: CookieReader, roles: readonly Role[], now = new Date()): SessionClaims {
  const claims = verifySession(store, now);
  if (!claims) throw new AuthError(401);
  if (!roles.includes(claims.role)) throw new AuthError(403);
  return claims;
}

export function homeFor(role: Role): string {
  return role === "hr_admin" ? "/admin" : role === "approver" ? "/approver" : "/employee";
}

/** For pages: redirects to sign-in when there is no valid session, and to the user's own home for a wrong role. */
export async function requirePageSession(roles: readonly Role[]): Promise<SessionClaims> {
  // Session checks compare expiry with the current time, so they must run at request time, never in a prerender
  // or a prefetch. connection() marks that point for Cache Components.
  await connection();
  const claims = verifySession(await cookies());
  if (!claims) redirect("/login");
  if (!roles.includes(claims.role)) redirect(homeFor(claims.role));
  return claims;
}
