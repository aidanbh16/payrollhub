import { SEED_TENANTS, seededPassword } from "@/scripts/lib/seed";

const admin = SEED_TENANTS[0].hrAdmin;

/**
 * The sign-in forms that must fail at step 1 alike (L0-01 DiD, generic failures), by what is wrong with them. Shared by
 * the response-shape test (tests/threats/L0-01-admin-mfa.test.ts) and the timing test (tests/isolated/), so both
 * check the same paths. A function, not a constant: the password comes from the credentials file, which exists only
 * after the seed.
 */
export const wrongLoginAttempts = () => ({
  "unknown organization": { organization: "initech", email: admin.email, password: seededPassword(admin.email) },
  "unknown email": { organization: "acme", email: "nobody@acme.test", password: seededPassword(admin.email) },
  "wrong password": { organization: "acme", email: admin.email, password: "Wrong-Password-1!" },
  "employee (SSO only)": { organization: "acme", email: "alice@acme.test", password: seededPassword(admin.email) },
  "malformed organization": { organization: "../ACME", email: admin.email, password: seededPassword(admin.email) },
});
