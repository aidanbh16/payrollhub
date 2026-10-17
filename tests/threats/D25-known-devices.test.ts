import { createHash, randomUUID } from "node:crypto";
import { createClient } from "redis";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { POST as loginPOST } from "@/app/api/auth/login/route";
import { POST as mfaPOST } from "@/app/api/auth/mfa/route";
import { KNOWN_DEVICE_COOKIE, accountHash } from "@/edge/known-devices";
import { LIMITS } from "@/edge/route-policy";
import { proxy } from "@/proxy";
import { SEED_TENANTS, seededPassword, seededTotpSecret } from "@/scripts/lib/seed";
import { setupSeededDatabase } from "../helpers/database";
import { formPost, staffLogin as staffLoginRequest, times, verdict, verdicts } from "../helpers/edge";
import { Browser, advance, staffLogin, totpNow, useFakeClock } from "../helpers/http";

// D25: two budgets per account for staff sign-in (L1-05, L0-01 defense in depth).
// - A known device (one that completed MFA for this account; cookie set only then, stored hashed in Redis) has its own
//   budget and skips the login-class ceiling, so an attacker cannot lock the real admin out of it.
// - Any other device gets 5 immediate attempts, then progressive delays enforced as 429 + Retry-After refusals.

setupSeededDatabase();

const [acme] = SEED_TENANTS;
const admin = acme.hrAdmin;
const FREE = LIMITS.unknownDevice.free;
let adminDevice: string; // the admin's known-device cookie value

const withKnown = (email: string, token: string) => staffLoginRequest(email, { cookie: `${KNOWN_DEVICE_COOKIE}=${token}` });

beforeAll(async () => {
  useFakeClock();
  const browser = new Browser();
  await staffLogin(browser, "acme", admin.email, seededPassword(admin.email), seededTotpSecret(admin.email));
  adminDevice = browser.jar.get(KNOWN_DEVICE_COOKIE)!;
});
afterAll(() => vi.useRealTimers());

describe("[L1-05] [L0-01 DiD] D25: the known-device cookie", () => {
  it("is set only after a successful MFA step, and Redis stores only its hash, under that account", async () => {
    advance(31);
    const browser = new Browser();
    await browser.post(loginPOST, "/api/auth/login", { organization: "acme", email: admin.email, password: seededPassword(admin.email) });
    expect(browser.jar.has(KNOWN_DEVICE_COOKIE)).toBe(false); // not after the password step
    await browser.post(mfaPOST, "/api/auth/mfa", { code: "000000" });
    expect(browser.jar.has(KNOWN_DEVICE_COOKIE)).toBe(false); // not after a failed code
    advance(31);
    await browser.post(loginPOST, "/api/auth/login", { organization: "acme", email: admin.email, password: seededPassword(admin.email) });
    await browser.post(mfaPOST, "/api/auth/mfa", { code: totpNow(seededTotpSecret(admin.email)) });
    const token = browser.jar.get(KNOWN_DEVICE_COOKIE)!;
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);

    const redis = await createClient({ url: process.env.REDIS_URL }).connect();
    const members = await redis.sMembers(`${process.env.RATE_LIMIT_PREFIX}:known:${accountHash("acme", admin.email)}`);
    await redis.quit();
    expect(members).toContain(createHash("sha256").update(token).digest("hex"));
    expect(members).not.toContain(token);
  });

  it("a known device keeps its own budget while an attacker exhausts the account's unknown-device budget", async () => {
    const attacker = await verdicts(times(FREE + 3, () => () => staffLoginRequest(admin.email)));
    expect(attacker.slice(FREE)).toEqual([429, 429, 429]);
    expect(await verdict(withKnown(admin.email, adminDevice))).toBe("passed");
  });

  it("the known-device budget is capped too", async () => {
    const email = admin.email;
    const results = await verdicts(times(LIMITS.knownDevice.max + 2, () => () => withKnown(email, adminDevice)));
    // One request was already used by the previous test.
    expect(results.filter((r) => r === "passed").length).toBe(LIMITS.knownDevice.max - 1);
    expect(results.at(-1)).toBe(429);
  });

  it("is bound to its account: it gives no known-device budget for another account", async () => {
    const other = acme.approver.email;
    const results = await verdicts(times(FREE + 1, () => () => withKnown(other, adminDevice)));
    expect(results.at(-1)).toBe(429);
  });

  it("an unknown or malformed cookie counts as an unknown device", async () => {
    const email = `${randomUUID()}@acme.test`;
    expect((await verdicts(times(FREE + 1, () => () => withKnown(email, "A".repeat(43))))).at(-1)).toBe(429);
    const other = `${randomUUID()}@acme.test`;
    expect((await verdicts(times(FREE + 1, () => () => withKnown(other, "not-a-token")))).at(-1)).toBe(429);
  });
});

describe("[L1-05] [L0-01 DiD] D25: unknown-device delays are retry-after refusals, not server sleeps", () => {
  it("after the free attempts, each next attempt must wait 1 s, 2 s, 4 s ...", async () => {
    const email = `${randomUUID()}@acme.test`;
    await verdicts(times(FREE, () => () => staffLoginRequest(email)));

    const timed = async () => {
      const start = performance.now();
      const res = await proxy(staffLoginRequest(email));
      return { status: res.headers.get("x-middleware-next") === "1" ? "passed" : res.status, retry: res.headers.get("retry-after"), ms: performance.now() - start };
    };

    const first = await timed();
    expect([first.status, first.retry]).toEqual([429, "1"]);
    expect(first.ms).toBeLessThan(250); // refused at once: the server does not hold the request

    advance(1); // wait out the 1 s delay
    expect((await timed()).status).toBe("passed");
    expect((await timed()).retry).toBe("2");
    advance(2);
    expect((await timed()).status).toBe("passed");
    expect((await timed()).retry).toBe("4");
  });

  it("attempts during the wait are refused without adding to the penalty", async () => {
    const email = `${randomUUID()}@acme.test`;
    await verdicts(times(FREE, () => () => staffLoginRequest(email)));
    for (let i = 0; i < 10; i++) expect(await verdict(staffLoginRequest(email))).toBe(429);
    advance(1);
    expect(await verdict(staffLoginRequest(email))).toBe("passed"); // still only the first 1 s step
  });
});

describe("[L1-05] [L0-01 DiD] D25: known devices skip the login-class ceiling", () => {
  it("a flood that exhausts the login ceiling blocks unknown devices but not the admin's known device", async () => {
    let flood: string | number = "passed";
    for (let i = 0; i < LIMITS.classCeiling.login.max + 5 && flood === "passed"; i++) {
      flood = await verdict(staffLoginRequest(`${randomUUID()}@acme.test`));
    }
    expect(flood).toBe(429);
    expect(await verdict(staffLoginRequest(`${randomUUID()}@acme.test`))).toBe(429);
    // Fresh known-device budget for the admin: a new device registered through a real MFA sign-in.
    advance(31);
    const browser = new Browser();
    await staffLogin(browser, "acme", admin.email, seededPassword(admin.email), seededTotpSecret(admin.email));
    const known = browser.jar.get(KNOWN_DEVICE_COOKIE)!;
    expect(await verdict(withKnown(admin.email, known))).toBe("passed");

    // Both steps of sign-in get through: the MFA step from a known device also skips the ceiling...
    const pending = `__Host-ph_session=acme.${"P".repeat(43)}`;
    const mfa = (cookie: string) => formPost("/api/auth/mfa", { code: "123456" }, { cookie });
    expect(await verdict(mfa(`${pending}; ${KNOWN_DEVICE_COOKIE}=${known}`))).toBe("passed");
    // ...while the MFA step from an unknown device is still held to it.
    expect(await verdict(mfa(pending))).toBe(429);
    expect(await verdict(mfa(`${pending}; ${KNOWN_DEVICE_COOKIE}=${"Z".repeat(43)}`))).toBe(429);
  });
});
