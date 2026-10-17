import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { consume } from "@/edge/rate-limiter";
import { LIMITS } from "@/edge/route-policy";
import { formPost, idpLogin, staffLogin, times, verdict, verdicts } from "../helpers/edge";

// L1-05 (Critical): a credential-stuffing flood on the login route.
// Primary control: Proxy throttles every login route per targeted account (tenant + normalized email) in Redis before
// any password or code is checked (proxy.ts, edge/rate-limiter.ts). Per-IP limits are off by default because Next.js
// gives Proxy no unforgeable client IP; see L1-05-trusted-ip.test.ts for a deployment behind a trusted reverse proxy.

// Staff sign-in from an unknown device (D25): this many immediate attempts, then "retry after" refusals.
const FREE = LIMITS.unknownDevice.free;
const MAX = LIMITS.account.max;
const fresh = () => `${randomUUID()}@acme.test`;

describe("L1-05: per-account login throttle", () => {
  it("a flood against one account hits the ceiling no matter what IP headers the client sends", async () => {
    const email = fresh();
    const results = await verdicts(
      times(FREE + 5, (i) => () => staffLogin(email, { "x-forwarded-for": `198.51.100.${i}`, "x-real-ip": `203.0.113.${i}` })),
    );
    expect(results.slice(0, FREE)).toEqual(times(FREE, () => "passed"));
    expect(results.slice(FREE)).toEqual(times(5, () => 429));
  });

  it("email case and whitespace variants count against the same account", async () => {
    const id = randomUUID();
    const variants = [`${id}@acme.test`, `${id.toUpperCase()}@ACME.TEST`, `  ${id}@Acme.Test  `, `\t${id}@acme.TEST\n`];
    const results = await verdicts(times(FREE + 1, (i) => () => staffLogin(variants[i % variants.length])));
    expect(results.filter((r) => r === "passed")).toHaveLength(FREE);
    expect(results[FREE]).toBe(429);
    // The organization is normalized the same way.
    expect(await verdict(staffLogin(`${id}@acme.test`, {}, " ACME "))).toBe(429);
    // A different account is unaffected.
    expect(await verdict(staffLogin(fresh()))).toBe("passed");
  });

  it("concurrent attempts cannot race past the limit", async () => {
    const email = fresh();
    const results = await Promise.all(times(50, () => verdict(staffLogin(email))));
    expect(results.filter((r) => r === "passed")).toHaveLength(FREE);
    expect(results.filter((r) => r === 429)).toHaveLength(50 - FREE);
  });

  it("the Redis update is atomic: 200 concurrent increments of one bucket allow exactly its limit", async () => {
    const bucket = { key: `atomic:${randomUUID()}`, max: 7, windowMs: 60_000 };
    const decisions = await Promise.all(times(200, () => consume([bucket])));
    expect(decisions.filter((d) => d.allowed)).toHaveLength(7);
  });

  it("the stand-in IdP's login form is throttled per tenant and email", async () => {
    const email = fresh();
    const results = await verdicts(times(MAX + 2, () => () => idpLogin("acme", ` ${email.toUpperCase()} `)));
    expect(results.slice(0, MAX).every((r) => r === "passed")).toBe(true);
    expect(results.slice(MAX)).toEqual([429, 429]);
    // Same email at another tenant's IdP is a different account.
    expect(await verdict(idpLogin("globex", email))).toBe("passed");
  });

  it("the MFA step is throttled per pending session", async () => {
    const cookie = `__Host-ph_session=acme.${"A".repeat(43)}`;
    const mfa = () => formPost("/api/auth/mfa", { code: "123456" }, { cookie });
    const results = await verdicts(times(MAX + 1, () => mfa));
    expect(results[MAX]).toBe(429);
  });

  it("a throttled response says when to retry and reveals nothing about the account", async () => {
    const email = fresh();
    await verdicts(times(FREE, () => () => staffLogin(email)));
    const { proxy } = await import("@/proxy");
    const res = await proxy(staffLogin(email));
    expect(res.status).toBe(429);
    expect(Number(res.headers.get("retry-after"))).toBeGreaterThan(0);
    expect(await res.json()).toEqual({ error: "Too many requests" });
  });

  it("the route can still read the body after Proxy read it to find the account", async () => {
    const req = staffLogin(fresh());
    expect(await verdict(req)).toBe("passed");
    expect(Object.fromEntries(await req.formData())).toMatchObject({ organization: "acme" });
  });
});
