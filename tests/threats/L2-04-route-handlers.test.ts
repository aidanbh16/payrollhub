import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { GET as runGET } from "@/app/api/tenants/[tenantId]/runs/[runId]/route";
import { POST as createRunPOST } from "@/app/api/tenants/[tenantId]/runs/route";
import { POST as idpLoginPOST } from "@/app/mock-idp/[tenantId]/login/route";
import { POST as ssoCallbackPOST } from "@/app/api/auth/sso/[tenantId]/callback/route";
import { withTenant } from "@/data/db/tenant-scope";
import { SEED_TENANTS } from "@/scripts/lib/seed";
import { getPayrollRun } from "@/services/engine/repository";
import { rawSqlite, setupSeededDatabase } from "../helpers/database";
import { Browser, advance, staffLogin, useFakeClock } from "../helpers/http";

// L2-04 (Critical): a tenantId path/token mismatch writes a run into another tenant.
// Primary control: the route wrapper (application/http/route.ts) takes the tenant only from verified claims, refuses a
// path [tenantId] that differs, and validates bodies with strict schemas that never contain tenantId.

setupSeededDatabase();

const [acme, globex] = SEED_TENANTS;
const runsIn = (tenantId: string) =>
  (rawSqlite().prepare("SELECT count(*) AS n FROM payroll_run WHERE tenant_id = ?").get(tenantId) as { n: number }).n;
// Pay dates relative to the fake clock (2026-10-16): far enough ahead for the day-early schedule.
const PAY_DATE = "2026-11-13";

let acmeAdmin: Browser;
let globexAdmin: Browser;
let globexRunId: string;

beforeAll(async () => {
  useFakeClock();
  acmeAdmin = new Browser();
  await staffLogin(acmeAdmin, "acme", acme.hrAdmin.email, acme.hrAdmin.password, acme.hrAdmin.totpSecret);
  globexAdmin = new Browser();
  await staffLogin(globexAdmin, "globex", globex.hrAdmin.email, globex.hrAdmin.password, globex.hrAdmin.totpSecret);
  const created = await globexAdmin.json(createRunPOST, "/api/tenants/globex/runs", { payDate: PAY_DATE }, { tenantId: "globex" });
  globexRunId = (await created.json()).runId;
});
afterAll(() => vi.useRealTimers());

describe("L2-04: the tenant comes only from the verified session", () => {
  it("creates the run in the session's tenant (control case)", async () => {
    const res = await acmeAdmin.json(createRunPOST, "/api/tenants/acme/runs", { payDate: PAY_DATE }, { tenantId: "acme" });
    expect(res.status).toBe(201);
    const run = await res.json();
    expect(run).toMatchObject({ payDate: PAY_DATE, scheduledRunDate: "2026-11-12", status: "draft" });
    expect(withTenant("acme", (s) => getPayrollRun(s, run.runId))?.tenantId).toBe("acme");
  });

  it("refuses a path tenantId that differs from the session's, instead of correcting it", async () => {
    const before = [runsIn("acme"), runsIn("globex")];
    const write = await acmeAdmin.json(createRunPOST, "/api/tenants/globex/runs", { payDate: PAY_DATE }, { tenantId: "globex" });
    expect(write.status).toBe(403);
    expect(await write.json()).toEqual({ error: "Forbidden" });
    expect([runsIn("acme"), runsIn("globex")]).toEqual(before); // nothing written anywhere

    const read = await acmeAdmin.get(runGET, `/api/tenants/globex/runs/${globexRunId}`, { tenantId: "globex", runId: globexRunId });
    expect(read.status).toBe(403);
    // A tenant that does not exist gets the same answer, so the response says nothing about which tenants exist.
    const unknown = await acmeAdmin.json(createRunPOST, "/api/tenants/initech/runs", { payDate: PAY_DATE }, { tenantId: "initech" });
    expect([unknown.status, await unknown.json()]).toEqual([403, { error: "Forbidden" }]);
  });

  it("rejects a tenantId field in the body (strict schema), and writes nothing", async () => {
    const before = [runsIn("acme"), runsIn("globex")];
    const res = await acmeAdmin.json(createRunPOST, "/api/tenants/acme/runs", { payDate: PAY_DATE, tenantId: "globex" }, { tenantId: "acme" });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "Invalid request", issues: [{ path: "", message: 'Unrecognized key: "tenantId"' }] });
    expect([runsIn("acme"), runsIn("globex")]).toEqual(before);
  });

  it("rejects any other unknown field in the body or query", async () => {
    for (const extra of [{ status: "approved" }, { approvedBy: randomUUID() }, { createdBy: randomUUID() }, { runId: randomUUID() }]) {
      const res = await acmeAdmin.json(createRunPOST, "/api/tenants/acme/runs", { payDate: PAY_DATE, ...extra }, { tenantId: "acme" });
      expect(res.status).toBe(400);
      expect((await res.json()).issues[0].message).toMatch(/^Unrecognized key/);
    }
    const query = await acmeAdmin.get(runGET, `/api/tenants/acme/runs/${randomUUID()}?tenantId=globex`, { tenantId: "acme", runId: randomUUID() });
    expect(query.status).toBe(400);
  });

  it("a cross-tenant run id returns exactly the same response as one that does not exist", async () => {
    const crossTenant = await acmeAdmin.get(runGET, `/api/tenants/acme/runs/${globexRunId}`, { tenantId: "acme", runId: globexRunId });
    const missing = randomUUID();
    const nonexistent = await acmeAdmin.get(runGET, `/api/tenants/acme/runs/${missing}`, { tenantId: "acme", runId: missing });
    expect(crossTenant.status).toBe(404);
    expect([nonexistent.status, await nonexistent.text()]).toEqual([crossTenant.status, await crossTenant.text()]);
    // The owning tenant can read it, so the 404 above really was isolation, not a missing row.
    expect((await globexAdmin.get(runGET, `/api/tenants/globex/runs/${globexRunId}`, { tenantId: "globex", runId: globexRunId })).status).toBe(200);
  });

  it("checks the caller before anything else: no session is 401, an employee is 403", async () => {
    expect((await new Browser().json(createRunPOST, "/api/tenants/acme/runs", { payDate: PAY_DATE }, { tenantId: "acme" })).status).toBe(401);

    advance(31);
    const employee = new Browser();
    const idp = await employee.post(idpLoginPOST, "/mock-idp/acme/login", { email: "alice@acme.test", password: acme.employees[0].idpPassword }, { tenantId: "acme" });
    const assertion = (await idp.text()).match(/name="assertion" value="([^"]+)"/)![1];
    await employee.post(ssoCallbackPOST, "/api/auth/sso/acme/callback", { assertion }, { tenantId: "acme" });
    expect((await employee.json(createRunPOST, "/api/tenants/acme/runs", { payDate: PAY_DATE }, { tenantId: "acme" })).status).toBe(403);
  });

  it("rejects a pay date too soon for the day-early schedule with a plain message", async () => {
    const res = await acmeAdmin.json(createRunPOST, "/api/tenants/acme/runs", { payDate: "2026-10-17" }, { tenantId: "acme" });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/at least two days from today/);
  });
});
