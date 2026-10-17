// Every route that checks a password or a one-time code (L1-05; Assignment 5, Section 2.2), with how to find the
// account it targets. Proxy throttles each one per account before any auth code runs (see proxy.ts and
// edge/route-policy.ts), so a new login route is covered by adding it here. tests/threats/L0-01-admin-mfa.test.ts
// fails if a known login route is missing.

import type { Limit } from "./route-policy";

export interface LoginRoute {
  /** Stable name used in rate-limit keys, so each login route has its own counters. */
  name: string;
  /** Matches the request path of a POST that checks credentials. */
  pattern: RegExp;
  /** Which part of the request identifies the targeted account, for the per-account limit. */
  account:
    | { from: "form"; tenantField: string; emailField: string }
    | { from: "path-and-form"; emailField: string }
    | { from: "form-email"; emailField: string }
    | { from: "session-cookie" };
  /** D20: if Redis is down, login routes fail closed with 503. */
  failClosed: true;
  /**
   * D25: known devices (and, RT-04, devices that opened an unlock link) get their own budget and skip the login
   * ceiling. "account": known for the account named in the form (step 1; unknown devices get progressive delays).
   * "pending-session": known for the account of the pending session (the MFA step; Proxy looks the pending session up,
   * RT-06). A device known for some other account gets nothing.
   */
  knownDevices?: "account" | "pending-session";
  /** The route class for ceilings and body limits: "money" for the approve route, which also checks a code. */
  routeClass?: "money";
  /** The per-account limit, when it differs from LIMITS.account. */
  limit?: Limit;
}

/** RT-04 (D46): unlock-link requests per targeted account. */
export const UNLOCK_REQUEST_LIMIT: Limit = { max: 3, windowMs: 60 * 60_000 };

export const LOGIN_ROUTES: readonly LoginRoute[] = [
  // PayrollHub staff sign-in, step 1: organization + email + password.
  { name: "staff-login", pattern: /^\/api\/auth\/login$/, account: { from: "form", tenantField: "organization", emailField: "email" }, failClosed: true, knownDevices: "account" },
  // Staff sign-in, step 2: the TOTP code, keyed by the pending session (one attempt per session, then re-login).
  { name: "staff-mfa", pattern: /^\/api\/auth\/mfa$/, account: { from: "session-cookie" }, failClosed: true, knownDevices: "pending-session" },
  // Approval step-up: the approver's TOTP code, keyed by session. A money route, so it fails closed (D20).
  { name: "approve-step-up", pattern: /^\/api\/tenants\/[^/]+\/runs\/[^/]+\/approve$/, account: { from: "session-cookie" }, failClosed: true, routeClass: "money" },
  // The stand-in email provider's mailbox sign-in (D13): the mailbox address alone is the account.
  { name: "mailbox", pattern: /^\/dev\/outbox\/view$/, account: { from: "form-email", emailField: "address" }, failClosed: true },
  // Unlock-link requests (RT-04, D46): per targeted account, 3 an hour, the same whether or not the account exists.
  { name: "staff-unlock", pattern: /^\/api\/auth\/unlock$/, account: { from: "form", tenantField: "organization", emailField: "email" }, failClosed: true, limit: UNLOCK_REQUEST_LIMIT },
  // The stand-in IdP's own login form: tenant from the path, email from the form.
  { name: "idp-login", pattern: /^\/mock-idp\/[a-z][a-z0-9-]{1,39}\/login$/, account: { from: "path-and-form", emailField: "email" }, failClosed: true },
];
