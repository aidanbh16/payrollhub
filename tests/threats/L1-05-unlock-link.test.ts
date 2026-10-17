import { createHash, randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { GET as adminMeGET } from "@/app/api/admin/me/route";
import { POST as loginPOST } from "@/app/api/auth/login/route";
import { POST as unlockConfirmPOST } from "@/app/api/auth/unlock/confirm/route";
import { POST as unlockRequestPOST } from "@/app/api/auth/unlock/route";
import { getRedis } from "@/edge/redis";
import { LIMITS } from "@/edge/route-policy";
import { UNLOCK_COOKIE, UNLOCK_TTL_MS } from "@/edge/unlock";
import { openMailbox } from "@/partners/mock-mail/mail";
import { SEED_TENANTS, mailboxPasswordFor, seededPassword } from "@/scripts/lib/seed";
import { setupSeededDatabase } from "../helpers/database";
import { formPost, staffLogin as staffLoginRequest, times, verdict, verdicts } from "../helpers/edge";
import { Browser, location } from "../helpers/http";

// RT-04 (Turn 13 red team, L1-05 / D25): anyone who knew a staff member's organization and email could hold that
// account's unknown-device sign-in budget in backoff, so the real person could not sign in from a new device on pay
// day. Fix (D46): a self-service unlock link, sent only to the staff member's own mailbox, that gives a fresh sign-in
// budget to the browser that opens it. Conditions (Turn 14): the budget goes to the device that opens the link, not the
// one that asked; the link restores a budget and bypasses nothing (password and TOTP still required); requests are
// rate-limited per account and answer the same whether or not the account exists; single-use, short-lived, stored only
// as a hash, delivered only to the staff member's mailbox.

setupSeededDatabase();

const [acme] = SEED_TENANTS;
const approver = acme.approver;
const prefix = () => process.env.RATE_LIMIT_PREFIX!;
const sha256 = (v: string) => createHash("sha256").update(v).digest("hex");

/** A sign-in attempt for the approver as it reaches Proxy, from a browser with these cookies. */
const signIn = (cookie = "") => staffLoginRequest(approver.email, cookie ? { cookie } : {});
const askForUnlock = (browser: Browser, email: string, organization = "acme") =>
  browser.post(unlockRequestPOST, "/api/auth/unlock", { organization, email });

async function unlockMails(email: string) {
  return ((await openMailbox(email, mailboxPasswordFor(email))) ?? []).filter((m) => m.subject.startsWith("Unlock"));
}
/** Asks for an unlock link and returns the response and the token from the new mail (newest first; delivery is asynchronous). */
async function unlockVia(browser: Browser, email: string) {
  const before = (await unlockMails(email)).length;
  const res = await askForUnlock(browser, email);
  for (let i = 0; i < 50; i++) {
    const mail = await unlockMails(email);
    const token = mail.length > before ? mail[0].body.match(/\/login\/unlock#([A-Za-z0-9_-]{43})/)?.[1] : undefined;
    if (token) return { res, token };
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error(`no new unlock mail for ${email}`);
}
const confirm = (browser: Browser, token: string) => browser.json(unlockConfirmPOST, "/api/auth/unlock/confirm", { token });

describe("[L1-05] a locked-out staff member can unlock their own new device (RT-04)", () => {
  it("the Turn 13 reproduction: the lockout holds, and the unlock link opened by the staff member restores their sign-in", async () => {
    // The attacker spends the approver's unknown-device budget.
    await verdicts(times(LIMITS.unknownDevice.free + 4, () => () => signIn()));
    const victim = new Browser();
    expect(await verdict(signIn(victim.cookieHeader))).toBe(429);

    const { res, token } = await unlockVia(victim, approver.email);
    expect(location(res)).toBe("/login/unlock?sent=1");
    expect((await confirm(victim, token)).status).toBe(200);
    expect(victim.jar.get(UNLOCK_COOKIE)).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(await verdict(signIn(victim.cookieHeader))).toBe("passed");
  });

  it("the device that asked for the link gains nothing: the budget goes only to the browser that opens it", async () => {
    const attacker = new Browser();
    const { token } = await unlockVia(attacker, approver.email);
    const owner = new Browser();
    expect((await confirm(owner, token)).status).toBe(200);
    expect(attacker.jar.has(UNLOCK_COOKIE)).toBe(false);
    // The attacker keeps the account's unknown-device budget spent (a backoff is short at first, so do it right here).
    await verdicts(times(LIMITS.unknownDevice.free + 4, () => () => signIn(attacker.cookieHeader)));
    expect(await verdict(signIn(attacker.cookieHeader))).toBe(429);
    expect(await verdict(signIn(owner.cookieHeader))).toBe("passed");
  });

  it("the link restores a budget and bypasses nothing: the password and the TOTP step are still required", async () => {
    const owner = new Browser();
    await confirm(owner, (await unlockVia(owner, approver.email)).token);
    // The unlock cookie alone is not a session.
    expect((await owner.get(adminMeGET, "/api/admin/me")).status).toBe(401);
    // The right password gives only a pending session that waits for the code; it still cannot reach anything.
    const step1 = await owner.post(loginPOST, "/api/auth/login", { organization: "acme", email: approver.email, password: seededPassword(approver.email) });
    expect(location(step1)).toBe("/login/mfa");
    expect((await owner.get(adminMeGET, "/api/admin/me")).status).toBe(401);
  });

  it("unlock requests are limited per account and answer the same whether or not the account exists", async () => {
    const asked = (email: string, organization = "acme") => () => formPost("/api/auth/unlock", { organization, email });
    const limit = LIMITS.unlockRequest.max;
    expect(await verdicts(times(limit + 1, () => asked("approver@globex.test", "globex")))).toEqual([...times(limit, () => "passed"), 429]);
    expect(await verdicts(times(limit + 1, () => asked("nobody@globex.test", "globex")))).toEqual([...times(limit, () => "passed"), 429]);

    const shape = async (res: Response) => JSON.stringify([res.status, location(res), await res.text(), res.headers.getSetCookie()]);
    const real = await unlockVia(new Browser(), acme.hrAdmin.email); // the real account does get its mail
    const answers = new Set([
      await shape(real.res),
      await shape(await askForUnlock(new Browser(), "nobody@acme.test")),
      await shape(await askForUnlock(new Browser(), "alice@acme.test")), // an employee (SSO only)
      await shape(await askForUnlock(new Browser(), acme.hrAdmin.email, "initech")), // no such organization
    ]);
    expect(answers.size).toBe(1);
    expect(await unlockMails("alice@acme.test")).toEqual([]);
  });

  it("single-use, short-lived, stored only as a hash, and delivered only to the staff member's mailbox", async () => {
    const asker = new Browser();
    const { res, token } = await unlockVia(asker, approver.email);
    expect(await res.clone().text()).not.toContain(token);
    expect(res.headers.get("location")).not.toContain(token);
    // Only the approver's own mailbox received it.
    for (const other of [acme.hrAdmin.email, "alice@acme.test"]) {
      expect((await unlockMails(other)).some((m) => m.body.includes(token))).toBe(false);
    }
    // Redis holds the token's SHA-256, never the token, and only for UNLOCK_TTL_MS (15 minutes).
    const redis = await getRedis();
    const keys = await redis.keys(`${prefix()}:unlock-token:*`);
    expect(keys.some((k) => k.includes(token))).toBe(false);
    const key = `${prefix()}:unlock-token:${sha256(token)}`;
    expect(keys).toContain(key);
    const ttl = await redis.pTTL(key);
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(UNLOCK_TTL_MS);
    expect(UNLOCK_TTL_MS).toBe(15 * 60 * 1000);
    for (const k of keys) expect(await redis.get(k)).not.toContain(token);

    expect((await confirm(new Browser(), token)).status).toBe(200);
    const again = await confirm(new Browser(), token);
    expect(again.status).toBe(400);
    expect(await again.json()).toEqual({ error: "This unlock link is invalid or has expired" });

    // An expired link fails the same way.
    const late = (await unlockVia(asker, approver.email)).token;
    await redis.pExpire(`${prefix()}:unlock-token:${sha256(late)}`, 1);
    await new Promise((r) => setTimeout(r, 20));
    expect((await confirm(new Browser(), late)).status).toBe(400);
    expect((await confirm(new Browser(), randomUUID())).status).toBe(400);
  });
});
