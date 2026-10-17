import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { LIMITS } from "@/edge/route-policy";
import { idpLogin, staffLogin, times, verdicts } from "../helpers/edge";

// L1-05 in a deployment behind a reverse proxy that overwrites X-Real-IP with the real client address, configured
// with TRUSTED_CLIENT_IP_HEADER=x-real-ip. Only that header is read; X-Forwarded-For never is.

vi.hoisted(() => {
  process.env.TRUSTED_CLIENT_IP_HEADER = "x-real-ip";
});

const PER_IP = LIMITS.perIp.login.max;
const fresh = () => `${randomUUID()}@acme.test`;

describe("L1-05 with a trusted client-IP header", () => {
  it("a rotating-IP attack on one account still hits the per-account ceiling", async () => {
    const email = fresh();
    const results = await verdicts(times(LIMITS.unknownDevice.free + 5, (i) => () => staffLogin(email, { "x-real-ip": `203.0.113.${i + 1}` })));
    expect(results.filter((r) => r === "passed")).toHaveLength(LIMITS.unknownDevice.free);
    expect(results.slice(-5)).toEqual(times(5, () => 429));
  });

  it("a spoofed X-Forwarded-For does not reset the per-IP limit", async () => {
    const ip = `192.0.2.${Math.floor(Math.random() * 200) + 1}`;
    // Different accounts each time, so only the per-IP limit can trip; the attacker rotates X-Forwarded-For.
    const results = await verdicts(
      times(PER_IP + 3, (i) => () => idpLogin("acme", fresh(), { "x-real-ip": ip, "x-forwarded-for": `10.${i}.0.1, 198.51.100.${i}` })),
    );
    expect(results.filter((r) => r === "passed")).toHaveLength(PER_IP);
    expect(results.slice(-3)).toEqual([429, 429, 429]);
    // Another real client is unaffected.
    expect((await verdicts([() => idpLogin("acme", fresh(), { "x-real-ip": "192.0.2.250" })]))[0]).toBe("passed");
  });

  it("a header value that looks like a client-appended list is not trusted as an address", async () => {
    // Falls back to no per-IP bucket (still counted per account and per class), rather than a forgeable one.
    const results = await verdicts(times(3, (i) => () => staffLogin(fresh(), { "x-real-ip": `1.1.1.${i}, 2.2.2.2` })));
    expect(results).toEqual(["passed", "passed", "passed"]);
  });
});
