import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { redirect } from "next/navigation";
import { NextRequest } from "next/server";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { route } from "@/application/http/route";
import { ServiceAuthError } from "@/services/errors";
import { scanRouteSource, scanRoutes } from "../helpers/route-scan";

// The one route-handler pattern: every route is built by route.session/service/public, which checks the caller,
// validates strictly, and keeps internal errors out of responses.

const call = (handler: ReturnType<typeof route.public>, init?: RequestInit) =>
  handler(new NextRequest("http://localhost:3000/api/x", init as never), { params: Promise.resolve({}) });

describe("every route uses the wrapper (scan test)", () => {
  it("all route files under app/ are built by route.session, route.service, or route.public", () => {
    const { files, violations } = scanRoutes();
    expect(files).toEqual(
      expect.arrayContaining([
        "app/api/auth/login/route.ts",
        "app/api/tenants/[tenantId]/runs/route.ts",
        "app/api/internal/engine/tenants/[tenantId]/runs/[runId]/route.ts",
        "app/mock-idp/[tenantId]/login/route.ts",
      ]),
    );
    expect(violations).toEqual([]);
  });

  it("catches a real route file on disk that skips the wrapper", () => {
    const dir = join(__dirname, "..", "..", "app", "api", "__scan_probe");
    mkdirSync(dir, { recursive: true });
    try {
      writeFileSync(
        join(dir, "route.ts"),
        'import { NextResponse } from "next/server";\nexport async function GET() {\n  return NextResponse.json({ secret: true });\n}\n',
      );
      const found = scanRoutes().violations.filter((v) => v.file === "app/api/__scan_probe/route.ts").map((v) => v.problem);
      expect(found).toEqual(["GET is a plain exported function", "does not import the route wrapper"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
    expect(scanRoutes().violations).toEqual([]);
  });

  it("catches every other way around the wrapper", () => {
    const wrapped = 'import { route } from "@/application/http/route";\n';
    expect(scanRouteSource(`${wrapped}export const POST = async () => new Response();`)).toEqual(["POST is not built by route.session/service/public"]);
    expect(scanRouteSource(`${wrapped}export const GET = withSomethingElse(h);`)).toEqual(["GET is not built by route.session/service/public"]);
    expect(scanRouteSource(`${wrapped}export const GET = route.session({});\nexport { h as POST };`)).toEqual(["re-exports a handler with export { ... }"]);
    expect(scanRouteSource(`${wrapped}export * from "./other";`)).toEqual(["re-exports everything from another module", "exports no handler"]);
    expect(scanRouteSource(`${wrapped}// eslint-disable-next-line\nexport const GET = route.public({});`)).toEqual(["disables ESLint"]);
    expect(scanRouteSource(`${wrapped}export const GET = route.public({});`)).toEqual([]);
  });
});

describe("strict schemas are required when a route is defined", () => {
  const handler = () => ({});

  it("rejects a non-strict body schema (unknown fields would be silently dropped)", () => {
    expect(() => route.public({ body: { type: "json", schema: z.object({ a: z.string() }) }, handler })).toThrow(/z\.strictObject/);
    expect(() => route.public({ body: { type: "json", schema: z.looseObject({ a: z.string() }) }, handler })).toThrow(/z\.strictObject/);
    expect(() => route.public({ query: z.object({}) as never, handler })).toThrow(/z\.strictObject/);
  });

  it("rejects any schema that accepts a tenant field", () => {
    for (const key of ["tenantId", "TenantID", "tenant", "target_tenant"]) {
      expect(() => route.session({ roles: ["hr_admin"], body: { type: "json", schema: z.strictObject({ [key]: z.string() }) }, handler })).toThrow(
        /must not accept/,
      );
    }
    // A session route's tenant comes from the session; the path value is only compared, so params cannot declare it.
    expect(() => route.session({ roles: ["hr_admin"], params: z.strictObject({ tenantId: z.string() }), handler })).toThrow(/must not accept/);
  });
});

describe("error responses never leak internals", () => {
  it("an unexpected error returns a generic 500 with a request id, and the details stay in the server log", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const res = await call(
      route.public({
        handler: () => {
          throw new Error("SQLITE_ERROR: no such column: x in SELECT * FROM bank_account WHERE tenant_id = 'globex'");
        },
      }),
    );
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(Object.keys(body).sort()).toEqual(["error", "requestId"]);
    expect(body.error).toBe("Internal error");
    expect(JSON.stringify(body)).not.toMatch(/SELECT|SQLITE|bank_account|globex|at /);
    expect(res.headers.get("x-request-id")).toBe(body.requestId);
    expect(log).toHaveBeenCalled();
    log.mockRestore();
  });

  it("Next.js control-flow errors (redirect, prerender bail-out) pass through instead of becoming a 500", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(call(route.public({ handler: () => redirect("/login") }))).rejects.toThrow("NEXT_REDIRECT");
    expect(log).not.toHaveBeenCalled();
    log.mockRestore();
  });

  it("a service-auth failure reason is logged, never returned", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const res = await call(route.public({ handler: () => { throw new ServiceAuthError("grant revoked for approval -> engine.getRun"); } }));
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "Service authentication failed" });
    warn.mockRestore();
  });

  it("validation errors name the field but never echo the submitted value", async () => {
    const handler = route.public({ body: { type: "json", schema: z.strictObject({ payDate: z.iso.date() }) }, handler: () => ({}) });
    const res = await call(handler, { method: "POST", body: JSON.stringify({ payDate: "secret-value-123" }), headers: { "content-type": "application/json" } });
    expect(res.status).toBe(400);
    const text = await res.text();
    expect(text).toContain("payDate");
    expect(text).not.toContain("secret-value-123");
  });

  it("a malformed JSON body gets a generic 400", async () => {
    const handler = route.public({ body: { type: "json", schema: z.strictObject({ a: z.string() }) }, handler: () => ({}) });
    const res = await call(handler, { method: "POST", body: "{not json", headers: { "content-type": "application/json" } });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "Invalid request body" });
  });
});

describe("cross-site requests are refused (Origin and Fetch Metadata)", () => {
  const post = route.public({ handler: async () => ({ ok: true }) });
  const call = (headers: Record<string, string>) =>
    post(new NextRequest("http://localhost:3000/api/x", { method: "POST", headers }), { params: Promise.resolve({}) }).then((r) => r.status);

  it("allows the browser's own same-origin posts, including Origin: null under Referrer-Policy: no-referrer", async () => {
    expect(await call({ origin: "http://localhost:3000", "sec-fetch-site": "same-origin" })).toBe(200);
    expect(await call({ origin: "null", "sec-fetch-site": "same-origin" })).toBe(200);
    expect(await call({})).toBe(200); // not a browser: no Origin, no Fetch Metadata
  });

  it("refuses cross-site, same-site-but-other-origin, sandboxed, and mismatched requests", async () => {
    expect(await call({ origin: "https://evil.example", "sec-fetch-site": "cross-site" })).toBe(403);
    expect(await call({ origin: "null", "sec-fetch-site": "cross-site" })).toBe(403);
    expect(await call({ "sec-fetch-site": "same-site" })).toBe(403);
    expect(await call({ origin: "null" })).toBe(403); // opaque origin, no Fetch Metadata
    expect(await call({ origin: "https://evil.example" })).toBe(403);
    expect(await call({ origin: "https://evil.example", "sec-fetch-site": "same-origin" })).toBe(403);
  });
});
