import { z } from "zod";
import { tenantIdParam } from "./common";

// Sign-in form schemas. They are strict (unknown fields are rejected) and only bound sizes and normalize case;
// credential checks happen in Identity & Access, so a wrong value gets the same generic failure as any other.
// None of them accepts a tenantId: "organization" is what the user types, checked like a credential.

const text = (max: number) => z.string().trim().max(max);

export const staffLoginForm = z.strictObject({
  organization: text(40).toLowerCase(),
  email: text(254).toLowerCase(),
  password: z.string().max(256),
});

export const mfaForm = z.strictObject({
  code: text(12),
});

export const emptyForm = z.strictObject({});

/** RT-04 (D46): asking for an unlock link. Like sign-in, the answer never says whether the account exists. */
export const unlockRequestForm = z.strictObject({
  organization: text(40).toLowerCase(),
  email: text(254).toLowerCase(),
});

/** RT-04 (D46): opening an unlock link; the token comes from the link's fragment, posted in the body. */
export const unlockConfirmBody = z.strictObject({
  token: z.string().max(64),
});

export const ssoStartQuery = z.strictObject({
  organization: text(40).toLowerCase(),
});

/** The tenant in an SSO or IdP path only selects which tenant's sign-in runs; it is never a verified claim. */
export const signInTenantParams = z.strictObject({
  tenantId: tenantIdParam,
});

export const ssoCallbackForm = z.strictObject({
  assertion: z.string().max(8192),
});

export const idpLoginForm = z.strictObject({
  email: text(254).toLowerCase(),
  password: z.string().max(256),
});
