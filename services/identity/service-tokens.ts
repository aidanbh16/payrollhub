import "server-only";
import { randomUUID } from "node:crypto";
import { withPlatform } from "@/data/db/platform-scope";
import { withTenant } from "@/data/db/tenant-scope";
import { signJwt, verifyJwt } from "@/data/keys/kms";
import { ServiceAuthError } from "@/services/errors";
import { listServiceGrants, recordServiceTokenUse } from "./repository";

// Scoped service-to-service tokens (L1-19; Assignment 5, Section 2.4). Identity & Access is the only issuer and
// validator. A token names one calling service (sub), one target service (aud), one endpoint, and one tenant (tid),
// lives for 60 seconds, and is minted only if ServiceGrant allows that caller to reach that endpoint. Every service
// entry point verifies the token again, and re-checks the grant, so revoking a grant takes effect immediately.
// Tokens for the internal money routes (singleUse) are also recorded on first use, and a second use is refused.

export const SERVICE_ENDPOINTS = {
  "engine.createRun": { service: "engine", singleUse: false },
  "engine.updateRun": { service: "engine", singleUse: false },
  "engine.listRuns": { service: "engine", singleUse: false },
  "engine.reviewRun": { service: "engine", singleUse: false },
  "engine.payStatements": { service: "engine", singleUse: false },
  // Money-moving: issuing and redeeming approval tokens (L2-01).
  "approval.issueToken": { service: "approval", singleUse: true },
  "approval.redeemToken": { service: "approval", singleUse: true },
  // Money-moving: Payroll Engine computing a run (reached through /api/internal/engine).
  "engine.startRun": { service: "engine", singleUse: true },
  "bankAccount.readVerified": { service: "bank-account", singleUse: false },
  // Full account and routing numbers, verified accounts only: granted to ACH Disbursement alone.
  "bankAccount.readPayable": { service: "bank-account", singleUse: false },
  "bankAccount.summary": { service: "bank-account", singleUse: false },
  "bankAccount.viewChange": { service: "bank-account", singleUse: false },
  "bankAccount.adminList": { service: "bank-account", singleUse: false },
  // Money-redirecting: requesting and resolving bank-account changes (L2-11).
  "bankAccount.requestChange": { service: "bank-account", singleUse: true },
  "bankAccount.resolveChange": { service: "bank-account", singleUse: true },
  // Internal money routes (/api/internal/engine, /api/internal/ach). The run and batch actions added in Layers 6-7
  // are single-use too.
  "engine.getRun": { service: "engine", singleUse: true },
  "ach.getBatch": { service: "ach", singleUse: true },
  // Money-moving: building, signing, and sending a run's ACH batch (reached through /api/internal/ach).
  "ach.disburse": { service: "ach", singleUse: true },
} as const;

export type ServiceEndpoint = keyof typeof SERVICE_ENDPOINTS;
/** "bff" is the Next.js application layer (route handlers) calling a backend service on a user's behalf. */
export type ServiceName = "bff" | "identity" | "approval" | "engine" | "bank-account" | "ach";

const ISSUER = "payrollhub:identity";
const TTL_SECONDS = 60;
const TENANT_ID = /^[a-z][a-z0-9-]{1,39}$/;

export interface ServiceClaims {
  readonly caller: ServiceName;
  readonly endpoint: ServiceEndpoint;
  readonly tenantId: string;
  readonly tokenId: string;
}

/** What a service entry point accepts: a raw token, or the claims verifyServiceToken returned for it. */
export type ServiceAuth = string | ServiceClaims | undefined;

// Claims objects created by verifyServiceToken in this module. Only this module can add to the set, so an object
// built anywhere else is not accepted as proof of a verified (and, for single-use endpoints, consumed) token.
const verifiedCalls = new WeakSet<ServiceClaims>();

function hasGrant(caller: string, endpoint: string): boolean {
  return withPlatform((p) => listServiceGrants(p)).some((g) => g.callingService === caller && g.targetEndpoint === endpoint);
}

/** Mints a token for one call. Refuses if ServiceGrant does not let the caller reach the endpoint. */
export async function mintServiceToken(req: { caller: ServiceName; endpoint: ServiceEndpoint; tenantId: string }): Promise<string> {
  if (!TENANT_ID.test(req.tenantId)) throw new ServiceAuthError("invalid tenant");
  if (!(req.endpoint in SERVICE_ENDPOINTS)) throw new ServiceAuthError("unknown endpoint");
  if (!hasGrant(req.caller, req.endpoint)) throw new ServiceAuthError(`no grant for ${req.caller} -> ${req.endpoint}`);
  return signJwt(
    "service-token",
    { iss: ISSUER, sub: req.caller, aud: SERVICE_ENDPOINTS[req.endpoint].service, endpoint: req.endpoint, tid: req.tenantId, jti: randomUUID() },
    TTL_SECONDS,
  );
}

/**
 * Verifies a token for the endpoint being called. Rejects a missing, malformed, wrongly signed, or expired token, one
 * for another target service (audience) or endpoint, one for a different tenant than expected, and one whose grant
 * has since been revoked.
 */
export async function verifyServiceToken(
  token: string | undefined,
  expected: { endpoint: ServiceEndpoint; tenantId?: string },
): Promise<ServiceClaims> {
  if (!token) throw new ServiceAuthError("missing token");
  let payload;
  try {
    payload = await verifyJwt("service-token", token, {
      issuer: ISSUER,
      audience: SERVICE_ENDPOINTS[expected.endpoint].service,
      maxTokenAgeSeconds: TTL_SECONDS,
    });
  } catch {
    throw new ServiceAuthError("invalid, expired, or wrong-audience token");
  }
  if (payload.endpoint !== expected.endpoint) throw new ServiceAuthError("token is for a different endpoint");
  if (typeof payload.tid !== "string" || !TENANT_ID.test(payload.tid)) throw new ServiceAuthError("token has no tenant");
  if (expected.tenantId !== undefined && payload.tid !== expected.tenantId) throw new ServiceAuthError("token is for a different tenant");
  if (!hasGrant(String(payload.sub), expected.endpoint)) throw new ServiceAuthError("grant revoked");
  const tenantId = payload.tid;
  const tokenId = String(payload.jti);
  if (SERVICE_ENDPOINTS[expected.endpoint].singleUse) {
    const keepUntil = new Date(Math.max(payload.exp!, payload.iat! + TTL_SECONDS) * 1000);
    if (!withTenant(tenantId, (s) => recordServiceTokenUse(s, tokenId, keepUntil, new Date()))) {
      throw new ServiceAuthError("single-use token already used");
    }
  }
  const claims: ServiceClaims = Object.freeze({ caller: payload.sub as ServiceName, endpoint: expected.endpoint, tenantId, tokenId });
  verifiedCalls.add(claims);
  return claims;
}

/**
 * For Proxy's rate limits only (RT-03): the tenant a validly signed, unexpired service token is for, or null. It does
 * not check the endpoint, the grant, or single use, and it never spends the token: the route still verifies it fully.
 * It lets Proxy refuse an internal request with no valid token before counting it, and count real ones per tenant.
 */
export async function peekServiceToken(token: string | undefined): Promise<string | null> {
  if (!token) return null;
  try {
    const audiences = [...new Set(Object.values(SERVICE_ENDPOINTS).map((e) => e.service))];
    const payload = await verifyJwt("service-token", token, { issuer: ISSUER, audience: audiences, maxTokenAgeSeconds: TTL_SECONDS });
    return typeof payload.tid === "string" && TENANT_ID.test(payload.tid) ? payload.tid : null;
  } catch {
    return null;
  }
}

/**
 * The check every service entry point starts with. A raw token is verified (and consumed, if single-use). Claims are
 * accepted only if verifyServiceToken produced them in this process for this endpoint and tenant, which lets the
 * /api/internal route wrapper verify once and pass the result on without consuming a single-use token twice.
 */
export async function authorizeServiceCall(auth: ServiceAuth, expected: { endpoint: ServiceEndpoint; tenantId: string }): Promise<ServiceClaims> {
  if (typeof auth === "object" && auth !== null) {
    if (!verifiedCalls.has(auth)) throw new ServiceAuthError("unverified claims object");
    if (auth.endpoint !== expected.endpoint) throw new ServiceAuthError("verified call is for a different endpoint");
    if (auth.tenantId !== expected.tenantId) throw new ServiceAuthError("verified call is for a different tenant");
    return auth;
  }
  return verifyServiceToken(auth, expected);
}
