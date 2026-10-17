// Every route that checks a password or a one-time code (L1-05; Assignment 5, Section 2.2), with how to find the
// account it targets. Proxy throttles each one per account before any auth code runs (see proxy.ts and
// edge/route-policy.ts), so a new login route is covered by adding it here. tests/threats/L0-01-admin-mfa.test.ts
// fails if a known login route is missing.

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
   * D25: known devices get their own budget and skip the login ceiling. "account": known for the targeted account
   * (step 1; unknown devices get progressive delays). "any": known for any account (the MFA step, where Proxy has only
   * the pending session and cannot tell which account it is for).
   */
  knownDevices?: "account" | "any";
  /** The route class for ceilings and body limits: "money" for the approve route, which also checks a code. */
  routeClass?: "money";
}

export const LOGIN_ROUTES: readonly LoginRoute[] = [
  // PayrollHub staff sign-in, step 1: organization + email + password.
  { name: "staff-login", pattern: /^\/api\/auth\/login$/, account: { from: "form", tenantField: "organization", emailField: "email" }, failClosed: true, knownDevices: "account" },
  // Staff sign-in, step 2: the TOTP code, keyed by the pending session (one attempt per session, then re-login).
  { name: "staff-mfa", pattern: /^\/api\/auth\/mfa$/, account: { from: "session-cookie" }, failClosed: true, knownDevices: "any" },
  // Approval step-up: the approver's TOTP code, keyed by session. A money route, so it fails closed (D20).
  { name: "approve-step-up", pattern: /^\/api\/tenants\/[^/]+\/runs\/[^/]+\/approve$/, account: { from: "session-cookie" }, failClosed: true, routeClass: "money" },
  // The stand-in email provider's mailbox sign-in (D13): the mailbox address alone is the account.
  { name: "mailbox", pattern: /^\/dev\/outbox\/view$/, account: { from: "form-email", emailField: "address" }, failClosed: true },
  // The stand-in IdP's own login form: tenant from the path, email from the form.
  { name: "idp-login", pattern: /^\/mock-idp\/[a-z][a-z0-9-]{1,39}\/login$/, account: { from: "path-and-form", emailField: "email" }, failClosed: true },
];
