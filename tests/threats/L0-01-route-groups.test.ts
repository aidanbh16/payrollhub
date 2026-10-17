import { randomUUID } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { POST as ssoCallbackPOST } from "@/app/api/auth/sso/[tenantId]/callback/route";
import { GET as employeesGET } from "@/app/api/tenants/[tenantId]/employees/route";
import { POST as adminChangePOST } from "@/app/api/tenants/[tenantId]/employees/[employeeId]/bank-account/changes/route";
import { GET as myStatementGET } from "@/app/api/tenants/[tenantId]/me/pay-statements/[resultId]/route";
import { GET as myStatementsGET } from "@/app/api/tenants/[tenantId]/me/pay-statements/route";
import { GET as reviewGET } from "@/app/api/tenants/[tenantId]/runs/[runId]/review/route";
import { GET as runsGET } from "@/app/api/tenants/[tenantId]/runs/route";
import { POST as idpLoginPOST } from "@/app/mock-idp/[tenantId]/login/route";
import { withTenant } from "@/data/db/tenant-scope";
import { SEED_TENANTS, seededPassword, seededTotpSecret, seededIdpPassword } from "@/scripts/lib/seed";
import { insertPayrollRun } from "@/services/engine/repository";
import { computedRun } from "../helpers/ach";
import { idsFor, setupSeededDatabase } from "../helpers/database";
import { Browser, advance, staffLogin, totpNow, useFakeClock } from "../helpers/http";

// Section 2.1: the client layer's trust boundary. A session from the Employee portal carries no privileges the HR Admin
// and Payroll Approver consoles accept (defense in depth for L0-01), and an employee sees only their own records: the
// route handlers take the employee from the session, never from the request.

setupSeededDatabase();

const [acme] = SEED_TENANTS;
const [aliceSeed, bobSeed] = acme.employees;
let admin: Browser;
let approver: Browser;
let alice: Browser;
let bob: Browser;

async function ssoLogin(browser: Browser, tenantId: string, email: string, password: string) {
  const idp = await browser.post(idpLoginPOST, `/mock-idp/${tenantId}/login`, { email, password }, { tenantId });
  const assertion = (await idp.text()).match(/name="assertion" value="([^"]+)"/)![1];
  await browser.post(ssoCallbackPOST, `/api/auth/sso/${tenantId}/callback`, { assertion }, { tenantId });
}

async function signInAll() {
  admin = new Browser();
  await staffLogin(admin, "acme", acme.hrAdmin.email, seededPassword(acme.hrAdmin.email), seededTotpSecret(acme.hrAdmin.email));
  approver = new Browser();
  await staffLogin(approver, "acme", acme.approver.email, seededPassword(acme.approver.email), seededTotpSecret(acme.approver.email));
  alice = new Browser();
  await ssoLogin(alice, "acme", aliceSeed.email, seededIdpPassword(aliceSeed.email));
  bob = new Browser();
  await ssoLogin(bob, "acme", bobSeed.email, seededIdpPassword(bobSeed.email));
}

beforeAll(async () => {
  useFakeClock();
  await signInAll();
});

/** Every session route under app/api with the roles it declares, discovered from the source. */
function sessionRoutes() {
  const root = join(__dirname, "..", "..");
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) walk(path);
      else if (name === "route.ts") files.push(relative(root, path).split(sep).join("/"));
    }
  };
  walk(join(root, "app", "api"));
  const declared = files.reduce((n, file) => n + (readFileSync(join(root, file), "utf8").match(/route\.session\(/g)?.length ?? 0), 0);
  const parsed = files.flatMap((file) =>
    [...readFileSync(join(root, file), "utf8").matchAll(/export const (GET|POST) = route\.session\(\{\s*roles: \[([^\]]*)\]/g)].map((m) => ({
      file,
      method: m[1] as "GET" | "POST",
      roles: [...m[2].matchAll(/"(\w+)"/g)].map((r) => r[1]),
    })),
  );
  // No session route may escape the scan (for example by declaring its roles where this pattern does not look).
  expect(parsed).toHaveLength(declared);
  return parsed;
}

describe("[L0-01 DiD] Section 2.1: an employee session is refused by every console route", () => {
  // The only routes an employee session may use: the portal's own reads and bank-change actions. Fixed here, so a
  // console route that starts accepting employees fails this test instead of quietly leaving the sweep below.
  const EMPLOYEE_ROUTES = [
    "GET app/api/tenants/[tenantId]/me/bank-account/route.ts",
    "GET app/api/tenants/[tenantId]/me/pay-statements/route.ts",
    "GET app/api/tenants/[tenantId]/me/pay-statements/[resultId]/route.ts",
    "POST app/api/tenants/[tenantId]/bank-account/changes/route.ts",
    "POST app/api/tenants/[tenantId]/bank-account/changes/[changeId]/confirm/route.ts",
    "POST app/api/tenants/[tenantId]/bank-account/changes/[changeId]/reject/route.ts",
    "POST app/api/tenants/[tenantId]/bank-account/changes/[changeId]/view/route.ts",
  ];

  it("only the portal's own routes accept employees, and every other session route answers an employee with 403", async () => {
    const routes = sessionRoutes();
    const key = (r: { method: string; file: string }) => `${r.method} ${r.file}`;
    expect(routes.filter((r) => r.roles.includes("employee")).map(key).sort()).toEqual([...EMPLOYEE_ROUTES].sort());
    const consoleRoutes = routes.filter((r) => !EMPLOYEE_ROUTES.includes(key(r)));
    expect(consoleRoutes.length).toBeGreaterThanOrEqual(10);
    const results: string[] = [];
    for (const r of consoleRoutes) {
      const mod = await import(`@/${r.file.replace(/\.ts$/, "")}`);
      const segments = r.file.replace(/^app/, "").replace(/\/route\.ts$/, "").split("/");
      const params: Record<string, string> = {};
      const path = segments
        .map((seg) => {
          const m = /^\[(\w+)\]$/.exec(seg);
          if (!m) return seg;
          params[m[1]] = m[1] === "tenantId" ? "acme" : randomUUID();
          return params[m[1]];
        })
        .join("/");
      const res = r.method === "GET" ? await alice.get(mod.GET, path, params) : await alice.json(mod.POST, path, {}, params);
      results.push(`${r.method} ${path.replace(/[0-9a-f-]{36}/g, ":id")} -> ${res.status}`);
    }
    expect(results.filter((line) => !line.endsWith("-> 403"))).toEqual([]);
  });
});

describe("[L0-01 DiD] Section 2.1: an employee sees only their own pay statements", () => {
  it("another employee's statement id is 'not found', exactly like an id that does not exist", async () => {
    const runId = await computedRun(approver, "acme", "2026-11-27");
    const mine = await (await alice.get(myStatementsGET, "/api/tenants/acme/me/pay-statements", { tenantId: "acme" })).json();
    const bobs = await (await bob.get(myStatementsGET, "/api/tenants/acme/me/pay-statements", { tenantId: "acme" })).json();
    const aliceStatement = mine.statements.find((s: { runId: string }) => s.runId === runId);
    const bobStatement = bobs.statements.find((s: { runId: string }) => s.runId === runId);
    expect(aliceStatement).toMatchObject({ payDate: "2026-11-27", grossPayCents: 312_500, withholdingCents: 68_750, netPayCents: 243_750, accountLast4: "0101" });
    expect(bobStatement.netPayCents).toBe(224_250);
    expect(mine.statements.some((s: { resultId: string }) => s.resultId === bobStatement.resultId)).toBe(false);

    const own = await alice.get(myStatementGET, `/api/tenants/acme/me/pay-statements/${aliceStatement.resultId}`, { tenantId: "acme", resultId: aliceStatement.resultId });
    expect(own.status).toBe(200);
    const other = await alice.get(myStatementGET, `/api/tenants/acme/me/pay-statements/${bobStatement.resultId}`, { tenantId: "acme", resultId: bobStatement.resultId });
    const missing = await alice.get(myStatementGET, `/api/tenants/acme/me/pay-statements/${randomUUID()}`, { tenantId: "acme", resultId: randomUUID() });
    expect([other.status, await other.json()]).toEqual([404, { error: "Not found" }]);
    expect([missing.status, await missing.json()]).toEqual([404, { error: "Not found" }]);
    // The tenant in the path cannot be changed either.
    expect((await alice.get(myStatementsGET, "/api/tenants/globex/me/pay-statements", { tenantId: "globex" })).status).toBe(403);
  });
});

describe("Consoles show last 4 digits only, pending changes as unverified, and the late flag", () => {
  it("[L2-11 DiD] the HR Admin's employee list has last 4 digits, marks a pending change unverified, and holds no full number", async () => {
    const before = (await (await admin.get(employeesGET, "/api/tenants/acme/employees", { tenantId: "acme" })).json()).employees;
    const aliceId = before.find((e: { email: string }) => e.email === aliceSeed.email).employeeId;
    await admin.json(adminChangePOST, `/api/tenants/acme/employees/${aliceId}/bank-account/changes`, { routingNumber: "091000019", accountNumber: "555566661234" }, { tenantId: "acme", employeeId: aliceId });
    const res = await admin.get(employeesGET, "/api/tenants/acme/employees", { tenantId: "acme" });
    const text = await res.text();
    const { employees } = JSON.parse(text);
    const row = employees.find((e: { email: string }) => e.email === aliceSeed.email);
    expect(row.account.accountLast4).toBe("0101");
    expect(row.pending).toMatchObject({ accountLast4: "1234", requestedBy: "hr_admin" });
    for (const n of ["555566661234", "091000019", ...acme.employees.flatMap((e) => [e.accountNumber, e.routingNumber])]) expect(text).not.toContain(n);
  });

  it("[L2-11 DiD] the approver's review has totals, exceptions, last 4 digits, and no batch yet", async () => {
    const runId = await computedRun(approver);
    const res = await approver.get(reviewGET, `/api/tenants/acme/runs/${runId}/review`, { tenantId: "acme", runId });
    const text = await res.text();
    const review = JSON.parse(text);
    expect(review.totals).toEqual({ employees: 3, grossPayCents: 941_667, withholdingCents: 207_167, netPayCents: 734_500 });
    expect(review.exceptions).toEqual([]);
    expect(review.batch).toBeNull();
    expect(review.run).toMatchObject({ status: "computed", late: false });
    for (const e of acme.employees) expect(text).not.toContain(e.accountNumber);
  });

  // Last: moves the clock past a run's scheduled date.
  it("[L0-11 DiD] D29: a run computed after its scheduled date is flagged late in the list and the review", async () => {
    const runId = randomUUID();
    const { hrAdminId } = idsFor("acme");
    withTenant("acme", (s) => insertPayrollRun(s, { runId, payDate: "2026-10-20", status: "draft", createdBy: hrAdminId, approvedBy: null }));
    let runs = await (await approver.get(runsGET, "/api/tenants/acme/runs", { tenantId: "acme" })).json();
    expect(runs.runs.find((r: { runId: string }) => r.runId === runId).late).toBe(false);

    advance(5 * 24 * 3600); // 2026-10-21: after the scheduled run date (2026-10-19)
    await signInAll();
    runs = await (await approver.get(runsGET, "/api/tenants/acme/runs", { tenantId: "acme" })).json();
    expect(runs.runs.find((r: { runId: string }) => r.runId === runId).late).toBe(true); // would start late

    advance(31);
    const approved = await approver.json((await import("@/app/api/tenants/[tenantId]/runs/[runId]/approve/route")).POST, `/api/tenants/acme/runs/${runId}/approve`, { code: totpNow(seededTotpSecret(acme.approver.email)) }, { tenantId: "acme", runId });
    const { approvalToken } = await approved.json();
    const { startRun } = await import("@/services/engine/engine-service");
    const { mintAsBff } = await import("@/application/mint-as-bff");
    await startRun(await mintAsBff("engine.startRun", "acme"), { tenantId: "acme", runId, approvalToken });
    const review = await (await approver.get(reviewGET, `/api/tenants/acme/runs/${runId}/review`, { tenantId: "acme", runId })).json();
    expect(review.run).toMatchObject({ status: "computed", late: true, computedAt: expect.stringMatching(/^2026-10-21/) });
  });
});
