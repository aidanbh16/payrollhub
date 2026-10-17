import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { POST as loginPOST } from "@/app/api/auth/login/route";
import { KNOWN_DEVICE_COOKIE } from "@/edge/known-devices";
import { LIMITS } from "@/edge/route-policy";
import { SEED_TENANTS, seededPassword, seededTotpSecret } from "@/scripts/lib/seed";
import { setupSeededDatabase } from "../helpers/database";
import { formPost, staffLogin as staffLoginRequest, verdict } from "../helpers/edge";
import { Browser, staffLogin } from "../helpers/http";

// RT-06 (Turn 13 red team, L0-01 / D25): at the MFA step, a device known for ANY account got its own budget and skipped
// the login-class ceiling, so a browser that had completed MFA for the attacker's own account escaped the ceiling while
// guessing codes for someone else's pending session. Now the known-device check at the MFA step uses the account of the
// pending session (Proxy looks the pending session up), exactly like step 1.

setupSeededDatabase();

const [acme] = SEED_TENANTS;
let approverDevice: string; // known for approver@acme.test only
let adminDevice: string; // known for admin@acme.test

/** A real pending (password-checked, not yet MFA) session for the admin, in a browser carrying `knownCookie`. */
async function pendingAdmin(knownCookie: string) {
  const browser = new Browser();
  browser.jar.set(KNOWN_DEVICE_COOKIE, knownCookie);
  await browser.post(loginPOST, "/api/auth/login", { organization: "acme", email: acme.hrAdmin.email, password: seededPassword(acme.hrAdmin.email) });
  return browser;
}
const mfaStep = (browser: Browser) => formPost("/api/auth/mfa", { code: "000000" }, { cookie: browser.cookieHeader });

beforeAll(async () => {
  const approver = new Browser();
  await staffLogin(approver, "acme", acme.approver.email, seededPassword(acme.approver.email), seededTotpSecret(acme.approver.email));
  approverDevice = approver.jar.get(KNOWN_DEVICE_COOKIE)!;
  const admin = new Browser();
  await staffLogin(admin, "acme", acme.hrAdmin.email, seededPassword(acme.hrAdmin.email), seededTotpSecret(acme.hrAdmin.email));
  adminDevice = admin.jar.get(KNOWN_DEVICE_COOKIE)!;
});

describe("[L0-01 DiD] the MFA step's known-device budget is bound to the pending session's account (RT-06)", () => {
  it("the Turn 13 reproduction: a device known for another account is held to the login ceiling at the MFA step", async () => {
    const attacker = await pendingAdmin(approverDevice); // the approver's own device, attacking the admin's pending session
    const owner = await pendingAdmin(adminDevice);
    // Exhaust the login-class ceiling with a flood of anonymous sign-in attempts.
    let flood: string | number = "passed";
    for (let i = 0; i < LIMITS.classCeiling.login.max + 5 && flood === "passed"; i++) flood = await verdict(staffLoginRequest(`${randomUUID()}@acme.test`));
    expect(flood).toBe(429);

    expect(await verdict(mfaStep(attacker))).toBe(429);
    // The admin's own known device still gets through: D25 is unchanged for the right account.
    expect(await verdict(mfaStep(owner))).toBe("passed");
  });
});
