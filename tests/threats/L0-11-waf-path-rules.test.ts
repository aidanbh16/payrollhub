import { readFileSync } from "node:fs";
import { join } from "node:path";
import { NextRequest } from "next/server";
import { describe, expect, it } from "vitest";
import { proxy } from "@/proxy";
import { policyFor } from "@/edge/route-policy";
import { inspectRequest } from "@/edge/waf";

// RT-09 (Turn 13 red team, D8): the WAF claimed to turn away "encoded dots" and ".." path segments, but the URL parser
// resolves dot segments (including %2e%2e) before Proxy runs, so that rule could never fire and the comment overstated
// the control. The dead rule is gone and the comment says what actually happens: dot segments are resolved first, so
// Proxy and the router always see the same path, and encoded dots that survive inside a segment are refused.

const ORIGIN = "http://localhost:3000";
const get = (path: string) => new NextRequest(`${ORIGIN}${path}`);
const waf = (path: string) => inspectRequest(get(path), policyFor(new URL(`${ORIGIN}${path}`).pathname, "GET"))?.status ?? "passed";
const source = readFileSync(join(__dirname, "..", "..", "edge", "waf.ts"), "utf8");

describe("[L0-11] WAF path rules do what they say (RT-09)", () => {
  it("the Turn 13 reproduction: the dead '..' rule and its overstated comment are gone", () => {
    expect(source).not.toMatch(/includes\("\.\."\)/);
    expect(source).not.toMatch(/Path tricks that should never appear in a legitimate PayrollHub URL: encoded dots/);
    expect(source).toMatch(/are resolved by the URL parser before Proxy runs/);
  });

  it("dot segments, plain or encoded, are resolved before Proxy sees the URL", () => {
    for (const path of ["/api/%2e%2e/admin", "/api/%2E%2E/admin", "/api/../admin", "/x/./%2e/../admin"]) {
      expect(new URL(get(path).url).pathname, path).toBe("/admin");
    }
  });

  it("so they cannot reach a protected route without the session check", async () => {
    const api = await proxy(get("/x/%2e%2e/api/tenants/acme/runs"));
    expect(api.status).toBe(401);
    const page = await proxy(get("/x/%2e%2e/admin"));
    expect(page.headers.get("location")).toMatch(/\/login$/);
  });

  it("every remaining path rule fires on a URL that actually reaches Proxy", () => {
    expect(waf("/api/tenants/acme/runs/x%2e%2e")).toBe(400); // encoded dots inside a segment
    expect(waf("/api/tenants/acme/runs/a%2fb")).toBe(400); // encoded slash
    expect(waf("/api/tenants/acme/runs/a%5cb")).toBe(400); // encoded backslash
    expect(waf("/mock-idp/acme%00/login")).toBe(400); // NUL
    expect(waf("/api/tenants/acme/runs/a%0ab")).toBe(400); // encoded control character
    expect(waf("/api/tenants/acme/runs")).toBe("passed");
  });
});
