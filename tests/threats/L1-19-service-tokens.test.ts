import { generateKeyPairSync, randomUUID } from "node:crypto";
import { SignJWT, base64url, decodeProtectedHeader } from "jose";
import { NextRequest } from "next/server";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { GET as internalBatchGET } from "@/app/api/internal/ach/tenants/[tenantId]/runs/[runId]/batch/route";
import { GET as internalRunGET } from "@/app/api/internal/engine/tenants/[tenantId]/runs/[runId]/route";
import { withPlatform } from "@/data/db/platform-scope";
import { withTenant } from "@/data/db/tenant-scope";
import { SEED_TENANTS, seededPassword, seededTotpSecret } from "@/scripts/lib/seed";
import { insertAchBatch } from "@/services/ach/repository";
import { createDraftRun, getRun } from "@/services/engine/engine-service";
import { insertPayrollRun } from "@/services/engine/repository";
import { ServiceAuthError } from "@/services/errors";
import { mintServiceToken, type ServiceEndpoint, type ServiceName } from "@/services/identity/service-tokens";
import { idsFor, rawSqlite, setupSeededDatabase } from "../helpers/database";
import { Browser, advance, staffLogin, useFakeClock } from "../helpers/http";

// L1-19 (High): an unchecked service-to-service call reaches internal Payroll Engine endpoints.
// Primary control: Identity & Access mints short-lived tokens scoped to one caller, one endpoint, and one tenant, only
// when ServiceGrant allows it; every service entry point and every /api/internal/* route verifies them.

setupSeededDatabase();

const runs: Record<string, string> = {};
const mint = (caller: ServiceName, endpoint: ServiceEndpoint, tenantId = "acme") => mintServiceToken({ caller, endpoint, tenantId });

beforeAll(() => {
  useFakeClock();
  for (const tenantId of ["acme", "globex"]) {
    const runId = randomUUID();
    const { hrAdminId } = idsFor(tenantId);
    withTenant(tenantId, (s) => insertPayrollRun(s, { runId, payDate: "2026-11-27", status: "computed", createdBy: hrAdminId, approvedBy: null }));
    runs[tenantId] = runId;
  }
  withTenant("acme", (s) =>
    insertAchBatch(
      s,
      { batchId: randomUUID(), runId: runs.acme, idempotencyKey: randomUUID(), signature: Buffer.alloc(64), signingKeyVersion: 1, status: "signed", createdAt: new Date(), sentAt: null, entryCount: 0, totalCreditCents: 0 },
      "6220110000157301000001011234 FULL FILE BODY",
    ),
  );
});
afterAll(() => vi.useRealTimers());

/** A token with valid claims but signed by a key PayrollHub never issued, under the real key id. */
async function forged(endpoint: ServiceEndpoint) {
  const real = await mint("approval", "engine.getRun");
  const { privateKey } = generateKeyPairSync("ed25519");
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({ endpoint, tid: "acme", jti: randomUUID() })
    .setProtectedHeader({ alg: "EdDSA", kid: decodeProtectedHeader(real).kid })
    .setIssuer("payrollhub:identity").setAudience("engine").setSubject("approval").setIssuedAt(now).setExpirationTime(now + 60)
    .sign(privateKey);
}

const refused = (p: Promise<unknown>) => expect(p).rejects.toBeInstanceOf(ServiceAuthError);

describe("[L1-19] in-process: service entry points refuse calls without a valid scoped token", () => {
  it("accepts a token minted for this endpoint and tenant (control case)", async () => {
    const run = await getRun(await mint("approval", "engine.getRun"), { tenantId: "acme", runId: runs.acme });
    expect(run.runId).toBe(runs.acme);
  });

  it("refuses a missing token", async () => {
    await refused(getRun(undefined, { tenantId: "acme", runId: runs.acme }));
    await refused(getRun("", { tenantId: "acme", runId: runs.acme }));
  });

  it("refuses an expired token", async () => {
    const token = await mint("approval", "engine.getRun");
    advance(61);
    await refused(getRun(token, { tenantId: "acme", runId: runs.acme }));
  });

  it("refuses a token for a different endpoint of the same service", async () => {
    await refused(getRun(await mint("bff", "engine.createRun"), { tenantId: "acme", runId: runs.acme }));
    await refused(createDraftRun(await mint("bff", "engine.getRun"), { tenantId: "acme", payDate: "2026-12-11", createdBy: idsFor("acme").hrAdminId }));
  });

  it("refuses a token for a different service (wrong audience)", async () => {
    await refused(getRun(await mint("engine", "ach.getBatch"), { tenantId: "acme", runId: runs.acme }));
  });

  it("refuses a token minted for a different tenant", async () => {
    await refused(getRun(await mint("approval", "engine.getRun", "acme"), { tenantId: "globex", runId: runs.globex }));
  });

  it("refuses forged and unsigned tokens", async () => {
    await refused(getRun(await forged("engine.getRun"), { tenantId: "acme", runId: runs.acme }));
    const header = base64url.encode(JSON.stringify({ alg: "none", kid: "service-token:v1" }));
    const payload = base64url.encode(JSON.stringify({ iss: "payrollhub:identity", aud: "engine", sub: "approval", endpoint: "engine.getRun", tid: "acme" }));
    await refused(getRun(`${header}.${payload}.`, { tenantId: "acme", runId: runs.acme }));
  });

  it("will not mint a token for a caller ServiceGrant does not allow", async () => {
    await refused(mint("bank-account", "engine.getRun"));
    await refused(mint("ach", "engine.createRun"));
    await refused(mint("approval", "ach.getBatch"));
  });
});

describe("[L1-19] over HTTP: /api/internal/* refuses calls without a valid scoped token", () => {
  const get = (handler: typeof internalRunGET, path: string, params: Record<string, string>, headers: Record<string, string> = {}) =>
    handler(new NextRequest(`http://localhost:3000${path}`, { headers }), { params: Promise.resolve(params) });
  const runPath = (tenantId: string) => `/api/internal/engine/tenants/${tenantId}/runs/${runs[tenantId]}`;
  const runReq = (tenantId: string, token?: string) =>
    get(internalRunGET, runPath(tenantId), { tenantId, runId: runs[tenantId] }, token ? { authorization: `Bearer ${token}` } : {});
  const REFUSED = [401, { error: "Service authentication failed" }];
  const outcome = async (res: Response) => [res.status, await res.json()];

  it("accepts a valid token (control case)", async () => {
    const res = await runReq("acme", await mint("ach", "engine.getRun"));
    expect(res.status).toBe(200);
    expect((await res.json()).runId).toBe(runs.acme);
  });

  it("refuses a missing token, even with a signed-in HR Admin's session cookie", async () => {
    expect(await outcome(await runReq("acme"))).toEqual(REFUSED);
    const admin = new Browser();
    await staffLogin(admin, "acme", SEED_TENANTS[0].hrAdmin.email, seededPassword(SEED_TENANTS[0].hrAdmin.email), seededTotpSecret(SEED_TENANTS[0].hrAdmin.email));
    expect(await outcome(await get(internalRunGET, runPath("acme"), { tenantId: "acme", runId: runs.acme }, { cookie: [...admin.jar].map(([k, v]) => `${k}=${v}`).join("; ") }))).toEqual(REFUSED);
  });

  it("refuses an expired token", async () => {
    const token = await mint("ach", "engine.getRun");
    advance(61);
    expect(await outcome(await runReq("acme", token))).toEqual(REFUSED);
  });

  it("refuses a token for another endpoint or another service", async () => {
    expect(await outcome(await runReq("acme", await mint("bff", "engine.createRun")))).toEqual(REFUSED);
    expect(await outcome(await runReq("acme", await mint("engine", "ach.getBatch")))).toEqual(REFUSED);
  });

  it("refuses a token minted for a different tenant than the path", async () => {
    expect(await outcome(await runReq("globex", await mint("ach", "engine.getRun", "acme")))).toEqual(REFUSED);
  });

  it("refuses a forged token", async () => {
    expect(await outcome(await runReq("acme", await forged("engine.getRun")))).toEqual(REFUSED);
  });

  it("[L2-12 DiD] the ACH internal route has the same protection and never returns the file body", async () => {
    const path = `/api/internal/ach/tenants/acme/runs/${runs.acme}/batch`;
    const params = { tenantId: "acme", runId: runs.acme };
    expect(await outcome(await get(internalBatchGET, path, params))).toEqual(REFUSED);
    expect(await outcome(await get(internalBatchGET, path, params, { authorization: `Bearer ${await mint("ach", "engine.getRun")}` }))).toEqual(REFUSED);
    const ok = await get(internalBatchGET, path, params, { authorization: `Bearer ${await mint("engine", "ach.getBatch")}` });
    expect(ok.status).toBe(200);
    const text = await ok.text();
    expect(JSON.parse(text)).toMatchObject({ runId: runs.acme, status: "signed" });
    expect(text).not.toMatch(/fileBody|FULL FILE BODY/);
  });
});

describe("[L1-19] tokens for the internal money routes are single-use", () => {
  const httpRun = (token: string) =>
    internalRunGET(new NextRequest(`http://localhost:3000/api/internal/engine/tenants/acme/runs/${runs.acme}`, { headers: { authorization: `Bearer ${token}` } }), {
      params: Promise.resolve({ tenantId: "acme", runId: runs.acme }),
    });

  it("a token replayed in-process is refused", async () => {
    const token = await mint("approval", "engine.getRun");
    expect((await getRun(token, { tenantId: "acme", runId: runs.acme })).runId).toBe(runs.acme);
    await refused(getRun(token, { tenantId: "acme", runId: runs.acme }));
  });

  it("a token replayed over HTTP is refused, on both internal routes", async () => {
    const token = await mint("ach", "engine.getRun");
    expect((await httpRun(token)).status).toBe(200);
    const replay = await httpRun(token);
    expect([replay.status, await replay.json()]).toEqual([401, { error: "Service authentication failed" }]);

    const batch = await mint("engine", "ach.getBatch");
    const batchReq = () =>
      internalBatchGET(new NextRequest(`http://localhost:3000/api/internal/ach/tenants/acme/runs/${runs.acme}/batch`, { headers: { authorization: `Bearer ${batch}` } }), {
        params: Promise.resolve({ tenantId: "acme", runId: runs.acme }),
      });
    expect((await batchReq()).status).toBe(200);
    expect((await batchReq()).status).toBe(401);
  });

  it("a token used over HTTP cannot then be used in-process (one store for both paths)", async () => {
    const token = await mint("ach", "engine.getRun");
    expect((await httpRun(token)).status).toBe(200);
    await refused(getRun(token, { tenantId: "acme", runId: runs.acme }));
  });

  it("other service tokens stay multi-use for their 60 seconds", async () => {
    const token = await mint("bff", "engine.createRun");
    const { hrAdminId } = idsFor("acme");
    await createDraftRun(token, { tenantId: "acme", payDate: "2026-12-11", createdBy: hrAdminId });
    await createDraftRun(token, { tenantId: "acme", payDate: "2026-12-18", createdBy: hrAdminId });
  });

  it("a hand-built claims object is not accepted as a verified call", async () => {
    const fake = Object.freeze({ caller: "approval", endpoint: "engine.getRun", tenantId: "acme", tokenId: randomUUID() }) as never;
    await refused(getRun(fake, { tenantId: "acme", runId: runs.acme }));
  });
});

describe("[L1-19] revoking a grant takes effect immediately", () => {
  it("a token minted before the grant was revoked is refused afterwards", async () => {
    const token = await mint("approval", "engine.getRun");
    withPlatform(() => {
      rawSqlite().prepare("DELETE FROM service_grant WHERE calling_service = 'approval' AND target_endpoint = 'engine.getRun'").run();
    });
    await refused(getRun(token, { tenantId: "acme", runId: runs.acme }));
    await refused(mint("approval", "engine.getRun"));
  });
});
