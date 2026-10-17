import { NextRequest } from "next/server";
import { DEVICE_COOKIE, SESSION_COOKIE } from "@/application/auth/cookie-names";
import { withTenant } from "@/data/db/tenant-scope";
import { proxy } from "@/proxy";
import { listUsers } from "@/services/identity/repository";
import { TTL, createSession, randomToken } from "@/services/identity/sessions";

// Requests as they reach Proxy, and how to read its verdict. NextResponse.next() marks a request that Proxy let through.

export const ORIGIN = "http://localhost:3000";

export function formPost(path: string, form: Record<string, string>, headers: Record<string, string> = {}) {
  const body = new URLSearchParams(form).toString();
  return new NextRequest(`${ORIGIN}${path}`, {
    method: "POST",
    body,
    headers: { "content-type": "application/x-www-form-urlencoded", "content-length": String(Buffer.byteLength(body)), origin: ORIGIN, ...headers },
  });
}

export function get(path: string, headers: Record<string, string> = {}) {
  return new NextRequest(`${ORIGIN}${path}`, { headers });
}

export type Verdict = "passed" | number;

/** "passed" if Proxy let the request through to the app, otherwise the status it answered with. */
export async function verdict(request: NextRequest): Promise<Verdict> {
  const res = await proxy(request);
  return res.headers.get("x-middleware-next") === "1" ? "passed" : res.status;
}

export const staffLogin = (email: string, headers: Record<string, string> = {}, organization = "acme") =>
  formPost("/api/auth/login", { organization, email, password: "irrelevant-for-the-throttle" }, headers);

export const idpLogin = (tenant: string, email: string, headers: Record<string, string> = {}) =>
  formPost(`/mock-idp/${tenant}/login`, { email, password: "irrelevant-for-the-throttle" }, headers);

export async function verdicts(requests: (() => NextRequest)[]): Promise<Verdict[]> {
  const out: Verdict[] = [];
  for (const make of requests) out.push(await verdict(make()));
  return out;
}

export const times = <T>(n: number, f: (i: number) => T) => Array.from({ length: n }, (_, i) => f(i));

/**
 * A real, MFA-verified session for a seeded user, created directly in the Session table (as a completed sign-in
 * would), as a Cookie header with its device cookie. For requests sent straight to Proxy. Needs a seeded database.
 */
export function signedInCookie(tenantId: string, email: string): string {
  const deviceId = randomToken();
  const value = withTenant(tenantId, (s) => {
    const user = listUsers(s).find((u) => u.email === email)!;
    return createSession(s, { userId: user.userId, deviceId, mfaVerifiedAt: new Date(), ttlMs: TTL.privileged, now: new Date() });
  });
  return `${SESSION_COOKIE}=${value}; ${DEVICE_COOKIE}=${deviceId}`;
}
