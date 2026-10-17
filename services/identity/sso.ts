import "server-only";
import { importSPKI, jwtVerify } from "jose";
import { withTenant } from "@/data/db/tenant-scope";
import { findUserBySsoSubject, getIdpConfig, recordAssertionUse } from "./repository";
import { TTL, createSession } from "./sessions";

// SSO assertion validation (L1-20; Assignment 5, Sections 2.4 and 2.5). An employee session is created only after the
// assertion passes every check against the tenant's own registered IdP configuration:
//   signature  - verified with the public key in TenantIdpConfig.signing_cert (D11), never a key from the assertion
//   algorithm  - pinned to ES256; "none", HMAC, and every other algorithm are refused
//   issuer     - must equal TenantIdpConfig.issuer
//   audience   - must equal TenantIdpConfig.audience
//   expiry     - exp must be in the future and iat no older than MAX_ASSERTION_AGE
//   tenant     - the tid claim must name the tenant whose callback received it, and the subject must be that
//                tenant's active employee
//   single use - the assertion id (jti) is recorded until the assertion expires; a second use is refused

export const SSO_ALGORITHM = "ES256";
const MAX_ASSERTION_AGE_SECONDS = 5 * 60;
const CLOCK_TOLERANCE_SECONDS = 30;
const TENANT_ID = /^[a-z][a-z0-9-]{1,39}$/;
const MAX_ASSERTION_LENGTH = 8192;

export interface VerifiedAssertion {
  subject: string;
  assertionId: string;
  /** When the assertion can no longer pass validation; its id must be remembered until then. */
  keepUntil: Date;
}

/** Validates an assertion without consuming it. Returns null if any check fails; never throws for a bad assertion. */
export async function verifySsoAssertion(tenantId: string, assertion: string, now = new Date()): Promise<VerifiedAssertion | null> {
  if (!TENANT_ID.test(tenantId) || assertion.length > MAX_ASSERTION_LENGTH) return null;
  const config = withTenant(tenantId, (s) => getIdpConfig(s));
  if (!config || config.certExpiresAt.getTime() <= now.getTime()) return null;
  try {
    const key = await importSPKI(config.signingCert, SSO_ALGORITHM);
    const { payload } = await jwtVerify(assertion, key, {
      algorithms: [SSO_ALGORITHM],
      issuer: config.issuer,
      audience: config.audience,
      requiredClaims: ["sub", "iat", "exp", "tid", "jti"],
      maxTokenAge: MAX_ASSERTION_AGE_SECONDS,
      clockTolerance: CLOCK_TOLERANCE_SECONDS,
      currentDate: now,
    });
    if (payload.tid !== tenantId || typeof payload.sub !== "string" || typeof payload.jti !== "string") return null;
    // Valid until whichever comes later, exp or the maximum age, plus the clock tolerance jose allows.
    const lastValidSecond = Math.max(payload.exp!, payload.iat! + MAX_ASSERTION_AGE_SECONDS) + CLOCK_TOLERANCE_SECONDS;
    return { subject: payload.sub, assertionId: payload.jti, keepUntil: new Date(lastValidSecond * 1000) };
  } catch {
    return null;
  }
}

/** Validates the assertion, consumes its id (rejecting a replay), and only then creates a new employee session. */
export async function signInWithSso(
  input: { tenantId: string; assertion: string; deviceId: string },
  now = new Date(),
): Promise<string | null> {
  const verified = await verifySsoAssertion(input.tenantId, input.assertion, now);
  if (!verified) return null;
  return withTenant(input.tenantId, (s) => {
    if (!recordAssertionUse(s, verified.assertionId, verified.keepUntil, now)) return null;
    const user = findUserBySsoSubject(s, verified.subject);
    if (!user || user.role !== "employee" || user.status !== "active") return null;
    return createSession(s, { userId: user.userId, deviceId: input.deviceId, mfaVerifiedAt: null, ttlMs: TTL.employee, now });
  });
}
