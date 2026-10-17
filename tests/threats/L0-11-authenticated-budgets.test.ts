import { randomUUID } from "node:crypto";
import { NextRequest } from "next/server";
import { describe, expect, it, vi } from "vitest";
import { getRedis } from "@/edge/redis";
import { mintServiceToken } from "@/services/identity/service-tokens";
import { SEED_TENANTS } from "@/scripts/lib/seed";
import { setupSeededDatabase } from "../helpers/database";
import { ORIGIN, formPost, signedInCookie, staffLogin, times, verdict, verdicts } from "../helpers/edge";

// RT-03 (Turn 13 red team, L0-11): every money route shared one global counter per route class, and Proxy counted a
// request before looking at who sent it. ~2 unauthenticated requests per second to any money path kept approval, run,
// send, and bank-change confirmation answering 429 for every tenant on pay day; and a burst of concurrent logins made
// the rate limiter's Redis calls slow, which tripped the D20 breaker and turned every login and money route into 503.
// Now: money and API routes refuse a request with no valid session (or, for /api/internal, no validly signed service
// token) before counting anything; signed-in traffic is counted per tenant and per session; and a slow Redis reply
// fails only that request instead of being treated as "Redis down".

setupSeededDatabase();

const [acme, globex] = SEED_TENANTS;
const json = (path: string, cookie: string, extra: Record<string, string> = {}) =>
  new NextRequest(`${ORIGIN}${path}`, {
    method: "POST",
    body: "{}",
    headers: { "content-type": "application/json", "content-length": "2", origin: ORIGIN, cookie, ...extra },
  });
const internal = (tenantId: string, token?: string) =>
  json(`/api/internal/ach/tenants/${tenantId}/runs/${randomUUID()}/disburse`, "", token ? { authorization: `Bearer ${token}` } : {});
const disburse = (tenantId: string, cookie: string) => json(`/api/tenants/${tenantId}/runs/${randomUUID()}/disburse`, cookie);

describe("[L0-11] money and API budgets belong to signed-in users (RT-03)", () => {
  it("the Turn 13 reproduction: 125 unauthenticated POSTs to a money route are refused before counting; no tenant is throttled", async () => {
    const flood = await verdicts(times(125, () => () => internal("acme")));
    expect(flood).toEqual(times(125, () => 401));
    // The other tenant's internal money route, with a real service token, and acme's approver: both still get through.
    expect(await verdict(internal("globex", await mintServiceToken({ caller: "bff", endpoint: "ach.disburse", tenantId: "globex" })))).toBe("passed");
    expect(await verdict(disburse("acme", signedInCookie("acme", acme.approver.email)))).toBe("passed");
  });

  it("forged session cookies are refused before counting, so they cannot spend a tenant's budget", async () => {
    const forged = () => `__Host-ph_session=acme.${randomUUID().replace(/-/g, "").padEnd(43, "A")}; __Host-ph_device=${"D".repeat(43)}`;
    expect(await verdicts(times(150, () => () => disburse("acme", forged())))).toEqual(times(150, () => 401));
    expect(await verdicts(times(150, () => () => new NextRequest(`${ORIGIN}/api/tenants/acme/runs`, { headers: { cookie: forged() } })))).toEqual(times(150, () => 401));
    expect(await verdict(new NextRequest(`${ORIGIN}/admin`, { headers: { cookie: forged() } }))).toBe(307);
    expect(await verdict(disburse("acme", signedInCookie("acme", acme.approver.email)))).toBe("passed");
  });

  it("one signed-in session that floods a money route hits its own limit; other sessions and tenants keep working", async () => {
    const flooder = signedInCookie("acme", acme.approver.email);
    const results = await verdicts(times(40, () => () => disburse("acme", flooder)));
    expect(results.at(-1)).toBe(429);
    expect(await verdict(disburse("acme", signedInCookie("acme", acme.approver.email)))).toBe("passed");
    expect(await verdict(disburse("globex", signedInCookie("globex", globex.approver.email)))).toBe("passed");
  });

  it("Redis slowness is not 'Redis down': a slow reply does not open the breaker for everyone", async () => {
    const redis = await getRedis();
    const original = redis.eval.bind(redis);
    const spy = vi.spyOn(redis, "eval");
    const slowBy = (ms: number) =>
      spy.mockImplementation((async (...args: Parameters<typeof original>) => {
        await new Promise((r) => setTimeout(r, ms));
        return original(...args);
      }) as typeof redis.eval);
    try {
      // A reply 1 s late (load, not an outage) still counts: the request is decided normally.
      slowBy(1000);
      expect(await verdict(staffLogin(`${randomUUID()}@acme.test`))).toBe("passed");
      // A reply later than the timeout fails only that request (login routes fail closed)...
      slowBy(2500);
      expect(await verdict(staffLogin(`${randomUUID()}@acme.test`))).toBe(503);
    } finally {
      spy.mockRestore();
    }
    // ...and the very next request, with Redis answering normally again, goes through: no breaker was tripped.
    expect(await verdict(staffLogin(`${randomUUID()}@acme.test`))).toBe("passed");
    expect(await verdict(disburse("acme", signedInCookie("acme", acme.approver.email)))).toBe("passed");
  }, 15_000);

  it("a burst of 330 concurrent staff logins gets 303s and 429s, never a platform-wide 503", async () => {
    const burst = await Promise.all(times(330, () => verdict(staffLogin(`${randomUUID()}@acme.test`))));
    expect(burst.filter((v) => v === 503)).toEqual([]);
    expect(await verdict(formPost("/api/auth/login", { organization: "acme", email: acme.hrAdmin.email, password: "x" }))).not.toBe(503);
    expect(await verdict(disburse("acme", signedInCookie("acme", acme.approver.email)))).toBe("passed");
  }, 30_000);
});
