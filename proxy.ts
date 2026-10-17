import { createHash } from "node:crypto";
import { NextResponse, type NextRequest } from "next/server";
import { SESSION_COOKIE } from "@/application/auth/cookie-names";
import { trustedClientIp } from "@/edge/client-ip";
import { KNOWN_DEVICE_COOKIE, accountHash, deviceHash, isKnownDevice, isKnownDeviceForAnyAccount } from "@/edge/known-devices";
import type { LoginRoute } from "@/edge/login-routes";
import { RateLimiterUnavailable, consume, type Bucket, type Decision } from "@/edge/rate-limiter";
import { LIMITS, policyFor, type Policy } from "@/edge/route-policy";
import { inspectRequest } from "@/edge/waf";
import { NONCE_HEADER, applySecurityHeaders, newNonce } from "@/edge/security-headers";
import { log } from "@/data/log/logger";

// Next.js 16 Proxy (formerly Middleware; D2): the edge security layer (Assignment 5, Section 2.2). It runs on every
// request (Node.js runtime) before any route, in this order:
//   1. WAF-style filtering (edge/waf.ts): method, URL, Content-Length, and content type, from headers alone;
//   2. rate limits in Redis (edge/rate-limiter.ts): a ceiling per route class (L0-11), and on login routes a
//      per-account limit (L1-05) applied before any password or code is checked. Staff sign-in has two budgets (D25):
//      a known device (one that completed MFA for this account) has its own and skips the login ceiling; any other
//      device gets progressive "retry after" delays. Per-IP limits apply only behind a trusted reverse proxy;
//   3. D20: if Redis is unreachable, login and money routes fail closed with 503; others continue with a warning;
//   4. the optimistic session check: a protected area with no session cookie is turned away. It never trusts the
//      cookie's contents; the Data Access Layer validates every session against the Session table;
//   5. browser security headers (edge/security-headers.ts): a per-request nonce and Content-Security-Policy, and
//      Cache-Control: no-store, on every response it passes on or creates.

const PROTECTED = [/^\/(admin|approver|employee)(\/|$)/, /^\/api\/(admin|approver|tenants)(\/|$)/];

const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");

/**
 * The account a login attempt targets: tenant + email, trimmed, lowercased, and hashed, so Redis never holds an email.
 * The body was already size-checked by the WAF step, and Next.js buffers it so the route can still read it.
 */
async function accountKey(route: LoginRoute, request: NextRequest): Promise<string> {
  const account = route.account;
  if (account.from === "session-cookie") return sha256(`session\n${request.cookies.get(SESSION_COOKIE)?.value ?? ""}`);
  let form: FormData | null = null;
  try {
    form = await request.clone().formData();
  } catch {
    // Unparseable body: counted against an "empty" account; the route itself will reject it.
  }
  if (account.from === "form-email") return accountHash("mailbox", form?.get(account.emailField));
  const tenant = account.from === "form" ? form?.get(account.tenantField) : request.nextUrl.pathname.split("/")[2];
  return accountHash(tenant, form?.get(account.emailField));
}

async function bucketsFor(request: NextRequest, policy: Policy): Promise<Bucket[]> {
  const ceiling: Bucket = { key: `class:${policy.cls}`, ...LIMITS.classCeiling[policy.cls] };
  const ip = trustedClientIp(request);
  const perIp: Bucket[] = ip ? [{ key: `ip:${policy.cls}:${sha256(ip)}`, ...LIMITS.perIp[policy.cls] }] : [];
  const login = policy.login;
  if (!login) return [ceiling, ...perIp];

  const account = await accountKey(login, request);
  const device = request.cookies.get(KNOWN_DEVICE_COOKIE)?.value;
  if (login.knownDevices === "any" && device && (await isKnownDeviceForAnyAccount(device))) {
    // MFA step from a known device: its own per-device budget, no login ceiling.
    return [{ key: `account:${login.name}:known:${deviceHash(device)}`, ...LIMITS.knownDevice }, ...perIp];
  }
  if (login.knownDevices === "account") {
    if (device && (await isKnownDevice(account, device))) {
      // Known device: its own budget and no login ceiling, so floods and other devices cannot lock it out.
      return [{ key: `account:${login.name}:known:${account}:${deviceHash(device)}`, ...LIMITS.knownDevice }, ...perIp];
    }
    return [ceiling, ...perIp, { kind: "backoff", key: `account:${login.name}:unknown:${account}`, ...LIMITS.unknownDevice }];
  }
  return [ceiling, ...perIp, { key: `account:${login.name}:${account}`, ...LIMITS.account }];
}

const warned = globalThis as unknown as { payrollhubLimiterWarnedAt?: number };
function warnDegraded(path: string) {
  if (Date.now() - (warned.payrollhubLimiterWarnedAt ?? 0) < 30_000) return;
  warned.payrollhubLimiterWarnedAt = Date.now();
  log.warn("edge.rate_limiter_unavailable", { note: "Redis down? Continuing without limits on non-critical routes", path });
}

const json = (status: number, error: string, headers: Record<string, string> = {}) =>
  NextResponse.json({ error }, { status, headers: { "Cache-Control": "no-store", ...headers } });

export async function proxy(request: NextRequest) {
  const nonce = newNonce();
  return applySecurityHeaders(await checkRequest(request, nonce), nonce);
}

async function checkRequest(request: NextRequest, nonce: string): Promise<NextResponse> {
  const { pathname } = request.nextUrl;
  const policy = policyFor(pathname, request.method);

  const rejected = inspectRequest(request, policy);
  if (rejected) return rejected;

  let decision: Decision;
  try {
    decision = await consume(await bucketsFor(request, policy));
  } catch (err) {
    if (!(err instanceof RateLimiterUnavailable)) throw err;
    if (policy.failClosed) return json(503, "Service temporarily unavailable", { "Retry-After": "5" });
    warnDegraded(pathname);
    decision = { allowed: true };
  }
  if (!decision.allowed) return json(429, "Too many requests", { "Retry-After": String(decision.retryAfterSeconds) });

  if (PROTECTED.some((p) => p.test(pathname)) && !request.cookies.has(SESSION_COOKIE)) {
    if (pathname.startsWith("/api/")) return json(401, "Not signed in");
    return NextResponse.redirect(new URL("/login", request.url));
  }
  // Next.js reads the nonce from the request's CSP header and puts it on every script it renders.
  const headers = new Headers(request.headers);
  headers.set(NONCE_HEADER, nonce);
  headers.set("Content-Security-Policy", applySecurityHeaders(NextResponse.next(), nonce).headers.get("Content-Security-Policy")!);
  return NextResponse.next({ request: { headers } });
}

export const config = {
  // Everything except Next.js build assets.
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
