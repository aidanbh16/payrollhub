import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { POST as loginPOST } from "@/app/api/auth/login/route";
import { SEED_TENANTS, seededPassword } from "@/scripts/lib/seed";
import { setupSeededDatabase } from "../helpers/database";
import { Browser, useFakeClock } from "../helpers/http";
import { wrongLoginAttempts } from "../helpers/login-attempts";

// L0-01 (defense in depth): generic login failures, timing half. The response half is in
// tests/threats/L0-01-admin-mfa.test.ts.
//
// This file runs on its own, after the parallel suite (npm run test:isolated, which npm test runs second; the
// "isolated" project in vitest.config.ts). A latency comparison measured while 36 other test files load the machine
// compares the load, not the code. Isolating it, rather than changing the sampling, was the author's decision in Turn 16.

setupSeededDatabase();
beforeAll(() => useFakeClock());
afterAll(() => vi.useRealTimers());

const admin = SEED_TENANTS[0].hrAdmin;

describe("[L0-01 DiD] generic login failures", () => {
  it("step 1 takes similar time whether the organization, email, or password was wrong", async () => {
    // Each path timed three times in a row; the fastest of the three is its duration.
    const time = async (form: Record<string, string>) => {
      const samples: number[] = [];
      for (let i = 0; i < 3; i++) {
        const start = performance.now();
        await new Browser().post(loginPOST, "/api/auth/login", form);
        samples.push(performance.now() - start);
      }
      return Math.min(...samples);
    };
    const correct = { organization: "acme", email: admin.email, password: seededPassword(admin.email) };
    const durations = [await time(correct)];
    for (const form of Object.values(wrongLoginAttempts())) durations.push(await time(form));
    // Every path runs exactly one scrypt verification (~tens of ms), so no path is several times faster.
    expect(Math.max(...durations) / Math.min(...durations)).toBeLessThan(2);
  });
});
