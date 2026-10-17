import { createHash } from "node:crypto";
import { NextResponse, type NextRequest } from "next/server";
import { DEVICE_COOKIE, SESSION_COOKIE } from "@/application/auth/cookie-names";
import { verifySession } from "@/application/auth/dal";
import { trustedClientIp } from "@/edge/client-ip";
import { KNOWN_DEVICE_COOKIE, accountHash, deviceHash, isKnownDevice } from "@/edge/known-devices";
import type { LoginRoute } from "@/edge/login-routes";
import { RateLimiterUnavailable, consume, type Bucket, type Decision } from "@/edge/rate-limiter";
import { LIMITS, policyFor, type Policy } from "@/edge/route-policy";
import { UNLOCK_COOKIE, isUnlockedDevice, unlockedDeviceHash } from "@/edge/unlock";
import { inspectRequest } from "@/edge/waf";
import { NONCE_HEADER, applySecurityHeaders, newNonce } from "@/edge/security-headers";
import { log } from "@/data/log/logger";
import { peekServiceToken } from "@/services/identity/service-tokens";
import { isPrivilegedRole, readSession } from "@/services/identity/sessions";

// Next.js 16 Proxy (formerly Middleware; D2): the edge security layer (Assignment 5, Section 2.2). It runs on every
// request (Node.js runtime) before any route, in this order:
//   1. WAF-style filtering (edge/waf.ts): method, URL, Content-Length, and content type, from headers alone;
//   2. who is calling (RT-03, D45): a protected page or API route, and every money route, needs a live session (looked
//      up in the Session table, as the Data Access Layer does); /api/internal/* needs a validly signed service token
//      (checked, not spent). Without one the request is refused (401, or a redirect to sign-in) BEFORE anything is
//      counted, so anonymous or forged traffic can never spend the budget signed-in users depend on;
//   3. rate limits in Redis (edge/rate-limiter.ts): signed-in and service traffic per tenant and per session; anonymous
//      traffic (sign-in, public pages) against a ceiling per route class (L0-11); on login routes a per-account limit
//      (L1-05) applied before any password or code is checked. Staff sign-in has two budgets (D25): a device known for
//      the targeted account (at the MFA step: the pending session's account, RT-06), or one that opened an unlock link
//      for it (RT-04), has its own and skips the login ceiling; any other device gets progressive "retry after" delays.
//      Per-IP limits apply only behind a trusted reverse proxy;
//   4. D20: if Redis is unreachable, login and money routes fail closed with 503; others continue with a warning. A
//      slow Redis reply fails only that request (RT-03);
//   5. browser security headers (edge/security-headers.ts): a per-request nonce and Content-Security-Policy, and
//      Cache-Control: no-store, on every response it passes on or creates.
// The checks here only decide whether to count and admit a request; the DAL and the route wrapper still verify every
// session and token in full.

const PROTECTED = [/^\/(admin|approver|employee)(\/|$)/, /^\/api\/(admin|approver|tenants)(\/|$)/];
const INTERNAL = /^\/api\/internal\//;

const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");

/** Who sent a request, as far as rate limits are concerned. */
type Caller = { kind: "anonymous" } | { kind: "session"; tenantId: string; session: string } | { kind: "service"; tenantId: string };

const json = (status: number, error: string, headers: Record<string, string> = {}) =>
  NextResponse.json({ error }, { status, headers: { "Cache-Control": "no-store", ...headers } });

/** Step 2: identifies the caller, or returns the refusal for a request that needs a session or token it lacks. */
async function identify(request: NextRequest, pathname: string): Promise<Caller | NextResponse> {
  if (INTERNAL.test(pathname)) {
    const token = /^Bearer (\S+)$/.exec(request.headers.get("authorization") ?? "")?.[1];
    const tenantId = await peekServiceToken(token);
    return tenantId ? { kind: "service", tenantId } : json(401, "Service authentication failed");
  }
  if (!PROTECTED.some((p) => p.test(pathname))) return { kind: "anonymous" };
  const claims = verifySession(request.cookies);
  if (claims) return { kind: "session", tenantId: claims.tenantId, session: claims.sessionId };
  if (pathname.startsWith("/api/")) return json(401, "Not signed in");
  return NextResponse.redirect(new URL("/login", request.url));
}

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

/** RT-06: the staff account a pending (password-checked, MFA not yet done) session belongs to, if it is one. */
function pendingAccount(request: NextRequest): string | null {
  const pending = readSession(request.cookies.get(SESSION_COOKIE)?.value, request.cookies.get(DEVICE_COOKIE)?.value);
  if (!pending || pending.mfaVerifiedAt || !isPrivilegedRole(pending.role)) return null;
  return accountHash(pending.tenantId, pending.email);
}

/** D25 and RT-04: the device's own sign-in budget for this account, if it is known for it or was unlocked for it. */
async function ownBudget(login: LoginRoute, account: string, request: NextRequest): Promise<Bucket | null> {
  const known = request.cookies.get(KNOWN_DEVICE_COOKIE)?.value;
  if (known && (await isKnownDevice(account, known))) {
    return { key: `account:${login.name}:known:${account}:${deviceHash(known)}`, ...LIMITS.knownDevice };
  }
  const unlocked = request.cookies.get(UNLOCK_COOKIE)?.value;
  if (unlocked && (await isUnlockedDevice(account, unlocked))) {
    return { key: `account:${login.name}:unlocked:${account}:${unlockedDeviceHash(unlocked)}`, ...LIMITS.unlockedDevice };
  }
  return null;
}

async function bucketsFor(request: NextRequest, policy: Policy, caller: Caller): Promise<Bucket[]> {
  const cls = policy.cls;
  const ip = trustedClientIp(request);
  const perIp: Bucket[] = ip ? [{ key: `ip:${cls}:${sha256(ip)}`, ...LIMITS.perIp[cls] }] : [];
  // Signed-in and service traffic: its tenant's ceiling, and for a session its own limit. Anonymous: the class ceiling.
  const scope: Bucket[] =
    caller.kind === "anonymous"
      ? [{ key: `class:${cls}`, ...LIMITS.classCeiling[cls] }]
      : [
          { key: `tenant:${caller.tenantId}:${cls}`, ...LIMITS.tenantCeiling[cls] },
          ...(caller.kind === "session" ? [{ key: `session:${cls}:${caller.session}`, ...LIMITS.perSession[cls] }] : []),
        ];
  const login = policy.login;
  if (!login) return [...scope, ...perIp];

  if (login.knownDevices === "account") {
    const account = await accountKey(login, request);
    const own = await ownBudget(login, account, request);
    // A known or unlocked device: its own budget and no login ceiling, so floods and other devices cannot lock it out.
    if (own) return [own, ...perIp];
    return [...scope, ...perIp, { kind: "backoff", key: `account:${login.name}:unknown:${account}`, ...LIMITS.unknownDevice }];
  }
  if (login.knownDevices === "pending-session") {
    const account = pendingAccount(request);
    const own = account ? await ownBudget(login, account, request) : null;
    if (own) return [own, ...perIp];
  }
  return [...scope, ...perIp, { key: `account:${login.name}:${await accountKey(login, request)}`, ...(login.limit ?? LIMITS.account) }];
}

const warned = globalThis as unknown as { payrollhubLimiterWarnedAt?: number };
function warnDegraded(path: string) {
  if (Date.now() - (warned.payrollhubLimiterWarnedAt ?? 0) < 30_000) return;
  warned.payrollhubLimiterWarnedAt = Date.now();
  log.warn("edge.rate_limiter_unavailable", { note: "Redis down or slow? Continuing without limits on non-critical routes", path });
}

export async function proxy(request: NextRequest) {
  const nonce = newNonce();
  return applySecurityHeaders(await checkRequest(request, nonce), nonce);
}

async function checkRequest(request: NextRequest, nonce: string): Promise<NextResponse> {
  const { pathname } = request.nextUrl;
  const policy = policyFor(pathname, request.method);

  const rejected = inspectRequest(request, policy);
  if (rejected) return rejected;

  const caller = await identify(request, pathname);
  if (caller instanceof NextResponse) return caller;

  let decision: Decision;
  try {
    decision = await consume(await bucketsFor(request, policy, caller));
  } catch (err) {
    if (!(err instanceof RateLimiterUnavailable)) throw err;
    if (policy.failClosed) return json(503, "Service temporarily unavailable", { "Retry-After": "5" });
    warnDegraded(pathname);
    decision = { allowed: true };
  }
  if (!decision.allowed) return json(429, "Too many requests", { "Retry-After": String(decision.retryAfterSeconds) });

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
