import { LOGIN_ROUTES, UNLOCK_REQUEST_LIMIT, type LoginRoute } from "./login-routes";

// Edge policy (Assignment 5, Section 2.2): which class each request belongs to, how big its body may be, and its
// rate limits. Limits are independent per class, so a flood on one class (e.g. login) never consumes another's budget.
// Within a class (RT-03, D45): a request that needs a session or a service token is checked for one before anything
// is counted, and signed-in traffic is counted per tenant and per session, never against a counter that anonymous
// traffic can fill. Only anonymous routes (sign-in, public pages, the stand-ins) share a global ceiling per class.

export type RouteClass = "login" | "money" | "api" | "page";

/**
 * Money-moving routes. With login routes, they fail closed (503) when the rate limiter is unavailable (D20).
 * The approve/start routes arrive in Layer 6; they are listed now so they are covered from the first commit.
 */
export const MONEY_ROUTES: readonly RegExp[] = [
  /^\/api\/internal\/(engine|ach)\//,
  /^\/api\/tenants\/[^/]+\/runs\/[^/]+\/(approve|start|disburse)$/,
  // Bank-account changes redirect pay (L2-11): requesting, confirming, and rejecting them.
  /^\/api\/tenants\/[^/]+\/(employees\/[^/]+\/)?bank-account\/changes(\/|$)/,
];

export interface Policy {
  cls: RouteClass;
  login?: LoginRoute;
  /** D20: refuse with 503 when the rate limiter cannot be consulted. */
  failClosed: boolean;
  /** Largest accepted body in bytes (0: no body allowed). */
  maxBodyBytes: number;
  methods: readonly string[];
}

const KIB = 1024;

export function policyFor(pathname: string, method: string): Policy {
  const login = method === "POST" ? LOGIN_ROUTES.find((r) => r.pattern.test(pathname)) : undefined;
  if (login) return { cls: login.routeClass ?? "login", login, failClosed: true, maxBodyBytes: 4 * KIB, methods: ["POST"] };
  if (MONEY_ROUTES.some((r) => r.test(pathname))) return { cls: "money", failClosed: true, maxBodyBytes: 32 * KIB, methods: ["GET", "HEAD", "POST"] };
  if (pathname.startsWith("/api/") || /^\/mock-idp\/[^/]+\/login$/.test(pathname)) {
    return { cls: "api", failClosed: false, maxBodyBytes: 32 * KIB, methods: ["GET", "HEAD", "POST"] };
  }
  return { cls: "page", failClosed: false, maxBodyBytes: 0, methods: ["GET", "HEAD"] };
}

export interface Limit {
  max: number;
  windowMs: number;
}

const MINUTE = 60_000;

export const LIMITS = {
  /** L1-05: attempts per targeted account (pending session for code steps, tenant + email at the IdP), per route. */
  account: { max: 10, windowMs: 15 * MINUTE } satisfies Limit,
  /** D25, staff sign-in from a device that has completed MFA for this account before: its own budget, no ceiling. */
  knownDevice: { max: 20, windowMs: 15 * MINUTE } satisfies Limit,
  /** D25, staff sign-in from any other device: 5 immediate attempts, then 1 s, 2 s, 4 s ... up to 15 min apart. */
  unknownDevice: { free: 5, baseMs: 1000, maxMs: 15 * MINUTE, idleMs: 15 * MINUTE },
  /**
   * L0-11: ceiling per route class for anonymous traffic (sign-in steps, public pages and API, the stand-ins), so
   * one class cannot exhaust the platform. Money routes are never anonymous (RT-03); the entry is unused.
   */
  classCeiling: {
    login: { max: 300, windowMs: MINUTE },
    money: { max: 120, windowMs: MINUTE },
    api: { max: 3000, windowMs: MINUTE },
    page: { max: 6000, windowMs: MINUTE },
  } satisfies Record<RouteClass, Limit>,
  /** RT-03: ceiling per tenant per class for signed-in (or service-token) traffic: one tenant cannot starve another. */
  tenantCeiling: {
    login: { max: 300, windowMs: MINUTE },
    money: { max: 120, windowMs: MINUTE },
    api: { max: 3000, windowMs: MINUTE },
    page: { max: 6000, windowMs: MINUTE },
  } satisfies Record<RouteClass, Limit>,
  /** RT-03: per signed-in session per class: one session cannot use up its tenant's ceiling. */
  perSession: {
    login: { max: 30, windowMs: MINUTE },
    money: { max: 30, windowMs: MINUTE },
    api: { max: 300, windowMs: MINUTE },
    page: { max: 300, windowMs: MINUTE },
  } satisfies Record<RouteClass, Limit>,
  /** RT-04 (D46): unlock-link requests per targeted account (applied through LOGIN_ROUTES' staff-unlock entry). */
  unlockRequest: UNLOCK_REQUEST_LIMIT,
  /** RT-04 (D46): staff sign-in from a device that opened an unlock link for this account: a fresh budget. */
  unlockedDevice: { max: 10, windowMs: 15 * MINUTE } satisfies Limit,
  /** Per client IP per class. Applied only when TRUSTED_CLIENT_IP_HEADER is configured (see edge/client-ip.ts). */
  perIp: {
    login: { max: 30, windowMs: 5 * MINUTE },
    money: { max: 60, windowMs: MINUTE },
    api: { max: 600, windowMs: MINUTE },
    page: { max: 1200, windowMs: MINUTE },
  } satisfies Record<RouteClass, Limit>,
};
