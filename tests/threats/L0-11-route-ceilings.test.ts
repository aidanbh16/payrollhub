import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { LIMITS } from "@/edge/route-policy";
import { formPost, get, idpLogin, staffLogin, times, verdict, verdicts } from "../helpers/edge";

// L0-11 (High): each route class has its own ceiling across all clients, so flooding one class (here, login) cannot
// starve the others (Assignment 5, Section 2.2: "a flood against the login route cannot throttle payroll approval").
// This is its own file, so the login ceiling starts unused.

describe("[L0-11] per-class ceilings", () => {
  it("a flood that exhausts the login ceiling leaves API, money, and page routes working", async () => {
    // Rotating accounts, so only the per-class ceiling can trip.
    const ceiling = LIMITS.classCeiling.login.max;
    const flood = await verdicts(times(ceiling + 5, () => () => staffLogin(`${randomUUID()}@acme.test`)));
    expect(flood.filter((r) => r === "passed")).toHaveLength(ceiling);
    expect(flood.slice(-5)).toEqual(times(5, () => 429));
    expect(await verdict(idpLogin("acme", `${randomUUID()}@acme.test`))).toBe(429); // same class: login
    expect(await verdict(get("/api/admin/me", { cookie: "__Host-ph_session=x" }))).toBe("passed");
    expect(await verdict(get(`/api/internal/engine/tenants/acme/runs/${randomUUID()}`))).toBe("passed");
    expect(await verdict(get("/admin", { cookie: "__Host-ph_session=x" }))).toBe("passed");
    expect(await verdict(formPost("/api/auth/logout", {}))).toBe("passed");
  });
});
