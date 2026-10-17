import { randomUUID } from "node:crypto";
import { NextRequest } from "next/server";
import { describe, expect, it } from "vitest";
import { LIMITS } from "@/edge/route-policy";
import { ORIGIN, formPost, get, idpLogin, staffLogin, times, verdict, verdicts } from "../helpers/edge";

// L0-11 (High): a platform-wide outage on a pay date.
// Primary control (local stand-in for the WAF, D8): Proxy rejects malformed and oversized requests from their headers
// before any body is read, and keeps each route's limits independent (Assignment 5, Section 2.2). The day-early
// schedule is the resilience backup (CHECK constraint on payroll_run).

/** A body stream that records whether anyone read it. highWaterMark 0: pull() runs only on a real read. */
function trackedBody(bytes: number) {
  const state = { read: false };
  const stream = new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        state.read = true;
        controller.enqueue(new Uint8Array(bytes));
        controller.close();
      },
    },
    { highWaterMark: 0 },
  );
  return { state, stream };
}

describe("[L0-11] request filtering before any body is read", () => {
  it("an oversized body is rejected with 413 and never read", async () => {
    const { state, stream } = trackedBody(10_000);
    const req = new NextRequest(`${ORIGIN}/api/auth/login`, {
      method: "POST",
      body: stream,
      headers: { "content-type": "application/x-www-form-urlencoded", "content-length": "10000" },
      duplex: "half",
    } as never);
    expect(await verdict(req)).toBe(413);
    expect(state.read).toBe(false);
  });

  it("a body without a declared length (chunked) is rejected with 411 and never read", async () => {
    const { state, stream } = trackedBody(100);
    const req = new NextRequest(`${ORIGIN}/api/tenants/acme/runs`, {
      method: "POST",
      body: stream,
      headers: { "content-type": "application/json", "transfer-encoding": "chunked" },
      duplex: "half",
    } as never);
    expect(await verdict(req)).toBe(411);
    expect(state.read).toBe(false);
  });

  it("rejects other malformed requests", async () => {
    const json = (headers: Record<string, string>) => new NextRequest(`${ORIGIN}/api/tenants/acme/runs`, { method: "POST", body: "{}", headers });
    expect(await verdict(json({ "content-type": "text/plain", "content-length": "2" }))).toBe(415);
    expect(await verdict(json({ "content-type": "application/json" }))).toBe(411);
    expect(await verdict(new NextRequest(`${ORIGIN}/api/tenants/acme/runs`, { method: "PUT", body: "{}", headers: { "content-length": "2" } }))).toBe(405);
    expect(await verdict(new NextRequest(`${ORIGIN}/admin`, { method: "POST", body: "x=1", headers: { "content-length": "3" } }))).toBe(405);
    expect(await verdict(get("/api/tenants/acme/runs/%2e%2e%2fglobex"))).toBe(400);
    expect(await verdict(get("/mock-idp/acme%00/login"))).toBe(400);
    expect(await verdict(get(`/api/admin/me?q=${"x".repeat(2100)}`))).toBe(414);
    expect(await verdict(get("/login", { "content-length": "5" }))).toBe(400);
  });

  it("a well-formed request passes", async () => {
    expect(await verdict(get("/login"))).toBe("passed");
    expect(await verdict(staffLogin(`${randomUUID()}@acme.test`))).toBe("passed");
  });
});

describe("[L0-11] limits are independent per route", () => {
  it("an account locked out of staff sign-in does not lock the IdP form or any other route", async () => {
    const email = `${randomUUID()}@acme.test`;
    await verdicts(times(LIMITS.account.max + 1, () => () => staffLogin(email)));
    expect(await verdict(staffLogin(email))).toBe(429);
    expect(await verdict(idpLogin("acme", email))).toBe("passed");
    expect(await verdict(get("/api/admin/me", { cookie: "__Host-ph_session=x" }))).toBe("passed");
    expect(await verdict(get("/login"))).toBe("passed");
    expect(await verdict(formPost("/api/auth/logout", {}))).toBe("passed");
  });
});
