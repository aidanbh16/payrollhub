import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { SEED_TENANTS } from "@/scripts/lib/seed";
import { mintServiceToken } from "@/services/identity/service-tokens";
import { setupSeededDatabase } from "../helpers/database";
import { formPost, get, idpLogin, signedInCookie, staffLogin, verdict } from "../helpers/edge";

// D20: when the rate limiter's Redis is unreachable, login and money-moving routes fail closed with 503; every other
// route keeps working and a warning is logged. Here Redis points at a port with nothing listening.

vi.hoisted(() => {
  process.env.REDIS_URL = "redis://127.0.0.1:6399";
});

// Proxy refuses requests without a valid session or service token before it consults Redis (RT-03), so the requests
// below carry real ones: these are the requests Redis is needed for.
setupSeededDatabase();
const [acme] = SEED_TENANTS;
const bearer = async (endpoint: "engine.getRun" | "ach.getBatch") =>
  ({ authorization: `Bearer ${await mintServiceToken({ caller: endpoint === "engine.getRun" ? "bff" : "engine", endpoint, tenantId: "acme" })}` });

describe("D20: Redis stopped", () => {
  it("[L1-05] login routes fail closed with 503", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await verdict(staffLogin(`${randomUUID()}@acme.test`))).toBe(503);
    expect(await verdict(formPost("/api/auth/mfa", { code: "123456" }))).toBe(503);
    expect(await verdict(idpLogin("acme", "alice@acme.test"))).toBe(503);
  });

  it("[L2-01 DiD] money-moving routes fail closed with 503", async () => {
    expect(await verdict(get(`/api/internal/engine/tenants/acme/runs/${randomUUID()}`, await bearer("engine.getRun")))).toBe(503);
    expect(await verdict(get(`/api/internal/ach/tenants/acme/runs/${randomUUID()}/batch`, await bearer("ach.getBatch")))).toBe(503);
    expect(await verdict(formPost(`/api/tenants/acme/runs/${randomUUID()}/approve`, {}, { cookie: signedInCookie("acme", acme.approver.email) }))).toBe(503);
  });

  it("[L0-11 DiD] other routes keep working, with a logged warning", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(await verdict(get("/login"))).toBe("passed");
    expect(await verdict(get("/api/admin/me", { cookie: signedInCookie("acme", acme.hrAdmin.email) }))).toBe("passed");
    expect(await verdict(formPost("/api/auth/logout", {}))).toBe("passed");
    expect(warn.mock.calls.some(([msg]) => String(msg).includes("edge.rate_limiter_unavailable"))).toBe(true);
  });

  it("[L1-05] the 503 says to retry later and nothing more", async () => {
    const { proxy } = await import("@/proxy");
    const res = await proxy(staffLogin(`${randomUUID()}@acme.test`));
    expect(res.status).toBe(503);
    expect(res.headers.get("retry-after")).toBe("5");
    expect(await res.json()).toEqual({ error: "Service temporarily unavailable" });
  });
});
