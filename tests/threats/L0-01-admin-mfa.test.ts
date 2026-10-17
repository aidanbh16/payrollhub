import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { GET as adminMeGET } from "@/app/api/admin/me/route";
import { POST as loginPOST } from "@/app/api/auth/login/route";
import { POST as logoutPOST } from "@/app/api/auth/logout/route";
import { POST as mfaPOST } from "@/app/api/auth/mfa/route";
import { POST as ssoCallbackPOST } from "@/app/api/auth/sso/[tenantId]/callback/route";
import { POST as idpLoginPOST } from "@/app/mock-idp/[tenantId]/login/route";
import { SESSION_COOKIE } from "@/application/auth/cookie-names";
import { verifySession } from "@/application/auth/dal";
import { withTenant } from "@/data/db/tenant-scope";
import { LOGIN_ROUTES } from "@/edge/login-routes";
import { SEED_TENANTS } from "@/scripts/lib/seed";
import { findUserByEmail } from "@/services/identity/repository";
import { TTL, createSession, parseSessionCookie, readSession, sha256 } from "@/services/identity/sessions";
import { stepUp } from "@/services/identity/step-up";
import { proxy } from "@/proxy";
import { rawSqlite, setupSeededDatabase } from "../helpers/database";
import { Browser, advance, location, staffLogin, totpNow, useFakeClock } from "../helpers/http";

// L0-01 (High): HR Admin account takeover with no MFA.
// Primary control: required TOTP MFA for HR Admin and Payroll Approver, enforced by the Data Access Layer
// (application/auth/dal.ts) on every request, with sessions stored server-side (services/identity/sessions.ts).

setupSeededDatabase();
beforeAll(() => useFakeClock());
afterAll(() => vi.useRealTimers());

const acme = SEED_TENANTS[0];
const admin = acme.hrAdmin;
const approver = acme.approver;

async function signedInAdmin() {
  advance(31); // a fresh TOTP step, so this login's code is not a replay of the previous test's
  const browser = new Browser();
  await staffLogin(browser, "acme", admin.email, admin.password, admin.totpSecret);
  return browser;
}

async function signedInEmployee() {
  const browser = new Browser();
  const idp = await browser.post(idpLoginPOST, "/mock-idp/acme/login", { email: "alice@acme.test", password: acme.employees[0].idpPassword }, { tenantId: "acme" });
  const assertion = (await idp.text()).match(/name="assertion" value="([^"]+)"/)![1];
  await browser.post(ssoCallbackPOST, "/api/auth/sso/acme/callback", { assertion }, { tenantId: "acme" });
  return browser;
}

/** The browser's cookie jar, in the shape the DAL reads. */
const cookies = (b: Browser) => ({ get: (n: string) => (b.jar.has(n) ? { value: b.jar.get(n)! } : undefined) });

const sessionRow = (cookie: string) =>
  rawSqlite().prepare("SELECT revoked_at FROM session WHERE session_id = ?").get(sha256(parseSessionCookie(cookie)!.token)) as
    | { revoked_at: number | null }
    | undefined;

describe("L0-01: required MFA for HR Admin and Payroll Approver", () => {
  it("a correct password without the TOTP step cannot reach an admin route", async () => {
    advance(31);
    const browser = new Browser();
    await browser.post(loginPOST, "/api/auth/login", { organization: "acme", email: admin.email, password: admin.password });
    expect(browser.session).toBeDefined();
    expect((await browser.get(adminMeGET, "/api/admin/me")).status).toBe(401);
  });

  it("completing the TOTP step reaches the admin route", async () => {
    const browser = await signedInAdmin();
    const res = await browser.get(adminMeGET, "/api/admin/me");
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ tenantId: "acme", email: admin.email, role: "hr_admin" });
  });

  it("no opt-out: an HR Admin session that skipped MFA is rejected even though the row exists", async () => {
    const browser = await signedInAdmin();
    const user = withTenant("acme", (s) => findUserByEmail(s, admin.email))!;
    const cookie = withTenant("acme", (s) =>
      createSession(s, { userId: user.userId, deviceId: browser.device!, mfaVerifiedAt: null, ttlMs: TTL.privileged, now: new Date() }),
    );
    browser.jar.set(SESSION_COOKIE, cookie);
    expect(readSession(cookie, browser.device)).not.toBeNull(); // the session itself is live...
    expect((await browser.get(adminMeGET, "/api/admin/me")).status).toBe(401); // ...but the DAL refuses it
  });

  it("an employee session hitting an admin route gets 403", async () => {
    const browser = await signedInEmployee();
    expect(readSession(browser.session, browser.device)?.role).toBe("employee");
    expect((await browser.get(adminMeGET, "/api/admin/me")).status).toBe(403);
  });

  it("a Payroll Approver session hitting an admin route gets 403", async () => {
    advance(31);
    const browser = new Browser();
    await staffLogin(browser, "acme", approver.email, approver.password, approver.totpSecret);
    expect((await browser.get(adminMeGET, "/api/admin/me")).status).toBe(403);
  });

  it("Proxy turns away a protected request with no session cookie before anything renders", async () => {
    const page = await proxy(new Browser().request("/admin"));
    expect(page.status).toBe(307);
    expect(location(page)).toBe("/login");
    expect((await proxy(new Browser().request("/api/admin/me"))).status).toBe(401);
  });
});

describe("session identifiers", () => {
  it("issues a new session id at login and again after MFA; the earlier ids stop working", async () => {
    const browser = await signedInAdmin();
    const before = browser.session!;

    advance(31);
    await browser.post(loginPOST, "/api/auth/login", { organization: "acme", email: admin.email, password: admin.password });
    const pending = browser.session!;
    expect(pending).not.toBe(before);
    expect(sessionRow(before)?.revoked_at).not.toBeNull(); // the session presented at login was revoked

    await browser.post(mfaPOST, "/api/auth/mfa", { code: totpNow(admin.totpSecret) });
    const final = browser.session!;
    expect(final).not.toBe(pending);
    expect(final).not.toBe(before);
    expect(sessionRow(pending)?.revoked_at).not.toBeNull();

    for (const old of [before, pending]) {
      const replay = new Browser();
      replay.jar.set("__Host-ph_device", browser.device!);
      replay.jar.set(SESSION_COOKIE, old);
      expect((await replay.get(adminMeGET, "/api/admin/me")).status).toBe(401);
    }
    expect((await browser.get(adminMeGET, "/api/admin/me")).status).toBe(200);
  });
});

describe("TOTP code reuse", () => {
  it("rejects a code that was already used in its time window", async () => {
    advance(31);
    const code = totpNow(admin.totpSecret);
    const first = new Browser();
    await first.post(loginPOST, "/api/auth/login", { organization: "acme", email: admin.email, password: admin.password });
    expect(location(await first.post(mfaPOST, "/api/auth/mfa", { code }))).toBe("/admin");

    const second = new Browser();
    await second.post(loginPOST, "/api/auth/login", { organization: "acme", email: admin.email, password: admin.password });
    expect(location(await second.post(mfaPOST, "/api/auth/mfa", { code }))).toBe("/login?error=signin");

    // The same code is also refused for the approval-time step-up.
    const claims = verifySession(cookies(first))!;
    expect(stepUp(claims, { code, deviceId: first.device })).toBeNull();
  });

  it("rejects a code from an earlier time step once a later one has been used", async () => {
    advance(31);
    const earlier = totpNow(admin.totpSecret);
    advance(30);
    const browser = new Browser();
    await staffLogin(browser, "acme", admin.email, admin.password, admin.totpSecret);
    expect((await browser.get(adminMeGET, "/api/admin/me")).status).toBe(200);

    const late = new Browser();
    await late.post(loginPOST, "/api/auth/login", { organization: "acme", email: admin.email, password: admin.password });
    expect(location(await late.post(mfaPOST, "/api/auth/mfa", { code: earlier }))).toBe("/login?error=signin");
  });
});

describe("approval-time step-up (called by Layer 6)", () => {
  it("a fresh code re-verifies MFA and replaces the session with a new id", async () => {
    const browser = await signedInAdmin();
    const claims = verifySession(cookies(browser))!;
    advance(31);
    const result = stepUp(claims, { code: totpNow(admin.totpSecret), deviceId: browser.device });
    expect(result).not.toBeNull();
    expect(result!.cookie).not.toBe(browser.session);
    expect(readSession(browser.session, browser.device)).toBeNull(); // pre-step-up session revoked
    expect(readSession(result!.cookie, browser.device)?.mfaVerifiedAt?.getTime()).toBe(result!.stepUpAt.getTime());
  });

  it("a wrong code, an employee, or a revoked session cannot step up", async () => {
    const browser = await signedInAdmin();
    const claims = verifySession(cookies(browser))!;
    expect(stepUp(claims, { code: "000000", deviceId: browser.device })).toBeNull();

    const employee = await signedInEmployee();
    expect(stepUp(verifySession(cookies(employee))!, { code: totpNow(admin.totpSecret), deviceId: employee.device })).toBeNull();

    await browser.post(logoutPOST, "/api/auth/logout", {});
    advance(31);
    expect(stepUp(claims, { code: totpNow(admin.totpSecret), deviceId: browser.device })).toBeNull();
  });
});

describe("session revocation and lifetime", () => {
  it("logout sets revoked_at and the same cookie stops working on the very next request", async () => {
    const browser = await signedInAdmin();
    const cookie = browser.session!;
    const device = browser.device!;
    await browser.post(logoutPOST, "/api/auth/logout", {});
    expect(sessionRow(cookie)?.revoked_at).not.toBeNull();

    const replay = new Browser();
    replay.jar.set("__Host-ph_device", device);
    replay.jar.set(SESSION_COOKIE, cookie);
    expect((await replay.get(adminMeGET, "/api/admin/me")).status).toBe(401);
  });

  it("an expired session is rejected", async () => {
    const browser = await signedInAdmin();
    advance(TTL.privileged / 1000 + 1);
    expect((await browser.get(adminMeGET, "/api/admin/me")).status).toBe(401);
  });

  it("a session cookie presented from another device is rejected", async () => {
    const browser = await signedInAdmin();
    const thief = new Browser();
    thief.jar.set(SESSION_COOKIE, browser.session!);
    expect((await thief.get(adminMeGET, "/api/admin/me")).status).toBe(401);
    thief.jar.set("__Host-ph_device", "A".repeat(43));
    expect((await thief.get(adminMeGET, "/api/admin/me")).status).toBe(401);
  });
});

describe("generic login failures", () => {
  const attempts = {
    "unknown organization": { organization: "initech", email: admin.email, password: admin.password },
    "unknown email": { organization: "acme", email: "nobody@acme.test", password: admin.password },
    "wrong password": { organization: "acme", email: admin.email, password: "Wrong-Password-1!" },
    "employee (SSO only)": { organization: "acme", email: "alice@acme.test", password: admin.password },
    "malformed organization": { organization: "../ACME", email: admin.email, password: admin.password },
  };

  it("every wrong field produces the same responses at both steps", async () => {
    advance(31);
    const shapes = new Set<string>();
    for (const form of Object.values(attempts)) {
      const browser = new Browser();
      const step1 = await browser.post(loginPOST, "/api/auth/login", form);
      const step2 = await browser.post(mfaPOST, "/api/auth/mfa", { code: totpNow(admin.totpSecret) });
      shapes.add(JSON.stringify([step1.status, location(step1), !!browser.session || "cleared", step2.status, location(step2)]));
    }
    // Right password, wrong code: same answers.
    const browser = new Browser();
    const step1 = await browser.post(loginPOST, "/api/auth/login", { organization: "acme", email: admin.email, password: admin.password });
    const step2 = await browser.post(mfaPOST, "/api/auth/mfa", { code: "123456" });
    shapes.add(JSON.stringify([step1.status, location(step1), !!browser.session || "cleared", step2.status, location(step2)]));

    expect([...shapes]).toEqual([JSON.stringify([303, "/login/mfa", "cleared", 303, "/login?error=signin"])]);
  });

  it("step 1 takes similar time whether the organization, email, or password was wrong", async () => {
    const time = async (form: Record<string, string>) => {
      const samples: number[] = [];
      for (let i = 0; i < 3; i++) {
        const start = performance.now();
        await new Browser().post(loginPOST, "/api/auth/login", form);
        samples.push(performance.now() - start);
      }
      return Math.min(...samples);
    };
    const correct = { organization: "acme", email: admin.email, password: admin.password };
    const durations = [await time(correct)];
    for (const form of Object.values(attempts)) durations.push(await time(form));
    // Every path runs exactly one scrypt verification (~tens of ms), so no path is several times faster.
    expect(Math.max(...durations) / Math.min(...durations)).toBeLessThan(2);
  });

  it("refuses a cross-origin login post", async () => {
    const res = await new Browser().post(loginPOST, "/api/auth/login", { organization: "acme", email: admin.email, password: admin.password }, {}, { origin: "https://evil.example" });
    expect(res.status).toBe(403);
  });
});

describe("rate-limiter hook for Layer 4 (L1-05)", () => {
  it("lists PayrollHub's login, the MFA step, and the stand-in IdP's login form", () => {
    const covers = (path: string) => LOGIN_ROUTES.some((r) => r.pattern.test(path));
    expect(covers("/api/auth/login")).toBe(true);
    expect(covers("/api/auth/mfa")).toBe(true);
    expect(covers("/mock-idp/acme/login")).toBe(true);
    expect(LOGIN_ROUTES.every((r) => r.failClosed)).toBe(true);
  });
});
