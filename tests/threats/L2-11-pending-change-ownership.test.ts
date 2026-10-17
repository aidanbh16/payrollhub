import { beforeAll, describe, expect, it } from "vitest";
import * as confirmRoute from "@/app/api/tenants/[tenantId]/bank-account/changes/[changeId]/confirm/route";
import { POST as employeeChangePOST } from "@/app/api/tenants/[tenantId]/bank-account/changes/route";
import { POST as adminChangePOST } from "@/app/api/tenants/[tenantId]/employees/[employeeId]/bank-account/changes/route";
import { POST as ssoCallbackPOST } from "@/app/api/auth/sso/[tenantId]/callback/route";
import { POST as idpLoginPOST } from "@/app/mock-idp/[tenantId]/login/route";
import { withTenant } from "@/data/db/tenant-scope";
import { openMailbox } from "@/partners/mock-mail/mail";
import { SEED_TENANTS, mailboxPasswordFor, seededIdpPassword, seededPassword, seededTotpSecret } from "@/scripts/lib/seed";
import { listEmployees } from "@/services/engine/repository";
import { listUsers } from "@/services/identity/repository";
import { rawSqlite, setupSeededDatabase } from "../helpers/database";
import { Browser, location, staffLogin, useFakeClock } from "../helpers/http";

// RT-07 (Turn 13 red team, L2-11): any new request superseded an employee's pending bank change and killed its link, so
// an HR Admin (or whoever holds that session) could cancel an employee's own change again and again, and the employee
// could never confirm it. Now an HR Admin request cannot supersede a change the employee requested (409); the employee
// can still replace their own pending change, or an HR Admin's.

setupSeededDatabase();

const [acme] = SEED_TENANTS;
const alice = acme.employees[0];
let admin: Browser;
let employee: Browser;
let aliceEmployeeId: string;

const status = (changeId: string) =>
  (rawSqlite().prepare("SELECT status, resolution FROM bank_account_change WHERE change_id = ?").get(changeId) as { status: string; resolution: string | null });

async function latestLink() {
  const messages = (await openMailbox(alice.email, mailboxPasswordFor(alice.email)))!;
  const body = messages.find((m) => m.subject.startsWith("Confirm"))!.body;
  const [, changeId, token] = body.match(/\/employee\/bank-change\/([0-9a-f-]{36})\?token=([A-Za-z0-9_-]+)/)!;
  return { changeId, token };
}

const employeeRequests = (accountNumber: string) =>
  employee.post(employeeChangePOST, "/api/tenants/acme/bank-account/changes", { routingNumber: "091000019", accountNumber }, { tenantId: "acme" });
const adminRequests = (accountNumber: string) =>
  admin.json(adminChangePOST, `/api/tenants/acme/employees/${aliceEmployeeId}/bank-account/changes`, { routingNumber: "122105278", accountNumber }, { tenantId: "acme", employeeId: aliceEmployeeId });
const confirm = (link: { changeId: string; token: string }) =>
  employee.post(confirmRoute.POST, `/api/tenants/acme/bank-account/changes/${link.changeId}/confirm`, { token: link.token }, { tenantId: "acme", changeId: link.changeId });

beforeAll(async () => {
  useFakeClock();
  admin = new Browser();
  await staffLogin(admin, "acme", acme.hrAdmin.email, seededPassword(acme.hrAdmin.email), seededTotpSecret(acme.hrAdmin.email));
  employee = new Browser();
  const idp = await employee.post(idpLoginPOST, "/mock-idp/acme/login", { email: alice.email, password: seededIdpPassword(alice.email) }, { tenantId: "acme" });
  const assertion = (await idp.text()).match(/name="assertion" value="([^"]+)"/)![1];
  await employee.post(ssoCallbackPOST, "/api/auth/sso/acme/callback", { assertion }, { tenantId: "acme" });
  aliceEmployeeId = withTenant("acme", (s) => listEmployees(s).find((e) => e.userId === listUsers(s).find((u) => u.email === alice.email)!.userId)!.employeeId);
});

describe("[L2-11 DiD] an HR Admin cannot supersede the employee's own pending change (RT-07)", () => {
  it("the Turn 13 reproduction: the employee's pending change survives an HR Admin request, and its link still confirms", async () => {
    expect(location(await employeeRequests("44441111"))).toBe("/employee?bank=requested");
    const own = await latestLink();

    const res = await adminRequests("44442222");
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "The employee has a pending bank change of their own; it must be confirmed or rejected first" });
    expect(status(own.changeId)).toEqual({ status: "pending", resolution: null });
    expect(await latestLink()).toEqual(own); // no new link was sent

    expect(location(await confirm(own))).toBe("/employee?bank=confirmed");
  });

  it("the employee can still replace their own pending change", async () => {
    await employeeRequests("44443333");
    const first = await latestLink();
    await employeeRequests("44444444");
    const second = await latestLink();
    expect(second.changeId).not.toBe(first.changeId);
    expect(status(first.changeId)).toEqual({ status: "rejected", resolution: "superseded" });
    expect(location(await confirm(second))).toBe("/employee?bank=confirmed");
  });

  it("an HR Admin's pending change can still be replaced, by the HR Admin or by the employee", async () => {
    expect((await adminRequests("44445555")).status).toBe(201);
    const byAdmin = await latestLink();
    expect((await adminRequests("44446666")).status).toBe(201);
    expect(status(byAdmin.changeId)).toEqual({ status: "rejected", resolution: "superseded" });
    const second = await latestLink();
    await employeeRequests("44447777");
    expect(status(second.changeId)).toEqual({ status: "rejected", resolution: "superseded" });
  });
});
