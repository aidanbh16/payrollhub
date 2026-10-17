import { randomUUID } from "node:crypto";
import { statSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import * as confirmRoute from "@/app/api/tenants/[tenantId]/bank-account/changes/[changeId]/confirm/route";
import * as rejectRoute from "@/app/api/tenants/[tenantId]/bank-account/changes/[changeId]/reject/route";
import { POST as employeeChangePOST } from "@/app/api/tenants/[tenantId]/bank-account/changes/route";
import { POST as adminChangePOST } from "@/app/api/tenants/[tenantId]/employees/[employeeId]/bank-account/changes/route";
import { POST as approvePOST } from "@/app/api/tenants/[tenantId]/runs/[runId]/approve/route";
import { POST as ssoCallbackPOST } from "@/app/api/auth/sso/[tenantId]/callback/route";
import * as outboxRoute from "@/app/dev/outbox/view/route";
import { POST as idpLoginPOST } from "@/app/mock-idp/[tenantId]/login/route";
import { mintAsBff } from "@/application/mint-as-bff";
import { withTenant } from "@/data/db/tenant-scope";
import { openMailbox } from "@/partners/mock-mail/mail";
import { SEED_TENANTS, mailboxPasswordFor } from "@/scripts/lib/seed";
import { LINK_TTL_MS, getBankSummary, viewBankChange } from "@/services/bank-account/bank-account-service";
import { isValidAccountNumber, isValidRoutingNumber } from "@/services/bank-account/validation";
import { startRun } from "@/services/engine/engine-service";
import { insertPayrollRun, listEmployees } from "@/services/engine/repository";
import { RunFailedError } from "@/services/errors";
import { listUsers } from "@/services/identity/repository";
import { idsFor, rawSqlite, setupSeededDatabase } from "../helpers/database";
import { Browser, advance, location, staffLogin, totpNow, useFakeClock } from "../helpers/http";

// L2-11 (Critical): an unverified bank-account change is paid. Defense in depth for L0-01: a taken-over HR Admin
// account cannot redirect pay.
// Primary control: the Bank Account service (services/bank-account/bank-account-service.ts) stores every change as
// PENDING and only an out-of-band confirmation by the employee, via a single-use, expiring, hash-stored link sent to
// their existing email (D13), makes it verified; Payroll Engine reads verified accounts only.

setupSeededDatabase();

const [acme, globex] = SEED_TENANTS;
const [aliceSeed, bobSeed] = acme.employees;
const danaSeed = globex.employees[0];

// New, valid account details used in this file. ABA check digits: 3·(0+0+0)+7·(9+0+1)+(1+0+9)=80; 3·4+7·9+15=90.
const NEW_ROUTING = "091000019";
const OTHER_ROUTING = "122105278";
const NEW_ACCOUNTS = Array.from({ length: 30 }, (_, i) => `5555${String(i).padStart(4, "0")}${4000 + i}`);
let nextAccount = 0;
const freshAccount = () => NEW_ACCOUNTS[nextAccount++];

let admin: Browser;
let approver: Browser;
let alice: Browser;
let bob: Browser;
let dana: Browser;
let aliceUserId: string;
let aliceEmployeeId: string;

// Everything the app writes to the console in this file, and every response body and Location header seen.
const logged: string[] = [];
const responses: string[] = [];

async function seen(res: Response): Promise<Response> {
  responses.push(`${res.status} ${res.headers.get("location") ?? ""} ${await res.clone().text()}`);
  return res;
}

const db = () => rawSqlite();
const changeRow = (changeId: string) =>
  db().prepare("SELECT status, resolution, requested_by, resolved_by, resolved_at FROM bank_account_change WHERE change_id = ?").get(changeId) as {
    status: string;
    resolution: string | null;
    requested_by: string;
    resolved_by: string | null;
    resolved_at: number | null;
  };
const accounts = (employeeId: string) =>
  db().prepare("SELECT bank_account_id, status FROM bank_account WHERE employee_id = ? ORDER BY verified_at").all(employeeId) as {
    bank_account_id: string;
    status: string;
  }[];
const verifiedIds = (employeeId: string) => accounts(employeeId).filter((a) => a.status === "verified").map((a) => a.bank_account_id);
const changeCount = (employeeId: string) =>
  (db().prepare("SELECT count(*) AS n FROM bank_account_change WHERE employee_id = ?").get(employeeId) as { n: number }).n;

async function ssoLogin(browser: Browser, tenantId: string, email: string, password: string) {
  const idp = await browser.post(idpLoginPOST, `/mock-idp/${tenantId}/login`, { email, password }, { tenantId });
  const assertion = (await idp.text()).match(/name="assertion" value="([^"]+)"/)![1];
  await browser.post(ssoCallbackPOST, `/api/auth/sso/${tenantId}/callback`, { assertion }, { tenantId });
}

const employeeIdFor = (tenantId: string, email: string) =>
  withTenant(tenantId, (s) => {
    const user = listUsers(s).find((u) => u.email === email)!;
    return listEmployees(s).find((e) => e.userId === user.userId)!.employeeId;
  });

/** The newest confirmation link in a mailbox, read with the mailbox's own password (as the employee would). */
async function latestLink(email: string) {
  const messages = (await openMailbox(email, mailboxPasswordFor(email)))!;
  const body = messages.find((m) => m.subject.startsWith("Confirm"))!.body;
  const [, changeId, token] = body.match(/\/employee\/bank-change\/([0-9a-f-]{36})\?token=([A-Za-z0-9_-]+)/)!;
  return { changeId, token };
}

async function adminRequests(employeeId: string, accountNumber = freshAccount(), routingNumber = NEW_ROUTING) {
  const res = await seen(
    await admin.json(adminChangePOST, `/api/tenants/acme/employees/${employeeId}/bank-account/changes`, { routingNumber, accountNumber }, { tenantId: "acme", employeeId }),
  );
  return { res, accountNumber };
}

async function aliceRequests(accountNumber = freshAccount(), routingNumber = OTHER_ROUTING) {
  const res = await seen(await alice.post(employeeChangePOST, "/api/tenants/acme/bank-account/changes", { routingNumber, accountNumber }, { tenantId: "acme" }));
  return { res, accountNumber };
}

async function decide(browser: Browser, decision: "confirm" | "reject", link: { changeId: string; token: string }, tenantId = "acme", headers: Record<string, string> = {}) {
  const handler = decision === "confirm" ? confirmRoute.POST : rejectRoute.POST;
  return seen(
    await browser.post(handler, `/api/tenants/${tenantId}/bank-account/changes/${link.changeId}/${decision}`, { token: link.token }, { tenantId, changeId: link.changeId }, headers),
  );
}

async function view(link: { changeId: string; token: string }, employeeUserId = aliceUserId, tenantId = "acme") {
  return viewBankChange(await mintAsBff("bankAccount.viewChange", tenantId), { tenantId, employeeUserId, changeId: link.changeId, token: link.token });
}

/** A draft run created by the HR Admin, approved by the approver; returns the approval token. */
async function approvedRun(): Promise<{ runId: string; token: string }> {
  const runId = randomUUID();
  const createdBy = idsFor("acme").hrAdminId;
  withTenant("acme", (s) => insertPayrollRun(s, { runId, payDate: "2026-11-27", status: "draft", createdBy, approvedBy: null }));
  advance(31);
  const res = await approver.json(approvePOST, `/api/tenants/acme/runs/${runId}/approve`, { code: totpNow(acme.approver.totpSecret) }, { tenantId: "acme", runId });
  expect(res.status).toBe(200);
  return { runId, token: (await res.json()).approvalToken };
}

const start = async (runId: string, approvalToken: string) =>
  startRun(await mintAsBff("engine.startRun", "acme"), { tenantId: "acme", runId, approvalToken });

const paidAccount = (runId: string, employeeId: string) =>
  (db().prepare("SELECT bank_account_id FROM pay_result WHERE run_id = ? AND employee_id = ?").get(runId, employeeId) as { bank_account_id: string }).bank_account_id;

/** Fresh PayrollHub sessions for everyone (after the clock jumps past the session lifetime). */
async function signInAll() {
  admin = new Browser();
  await staffLogin(admin, "acme", acme.hrAdmin.email, acme.hrAdmin.password, acme.hrAdmin.totpSecret);
  approver = new Browser();
  await staffLogin(approver, "acme", acme.approver.email, acme.approver.password, acme.approver.totpSecret);
  alice = new Browser();
  await ssoLogin(alice, "acme", aliceSeed.email, aliceSeed.idpPassword);
  bob = new Browser();
  await ssoLogin(bob, "acme", bobSeed.email, bobSeed.idpPassword);
  dana = new Browser();
  await ssoLogin(dana, "globex", danaSeed.email, danaSeed.idpPassword);
}

beforeAll(async () => {
  for (const method of ["log", "info", "warn", "error", "debug"] as const) {
    vi.spyOn(console, method).mockImplementation((...args: unknown[]) => void logged.push(args.map(String).join(" ")));
  }
  useFakeClock();
  await signInAll();
  aliceEmployeeId = employeeIdFor("acme", aliceSeed.email);
  aliceUserId = withTenant("acme", (s) => listUsers(s).find((u) => u.email === aliceSeed.email)!.userId);
});

afterAll(() => vi.restoreAllMocks());

describe("L2-11: a change is pending until the employee confirms it out of band", () => {
  it("an admin's change is pending, a run before confirmation pays the old verified account, and confirming switches it", async () => {
    const before = verifiedIds(aliceEmployeeId);
    expect(before).toHaveLength(1);

    const { res, accountNumber } = await adminRequests(aliceEmployeeId);
    expect(res.status).toBe(201);
    const receipt = await res.json();
    expect(receipt).toEqual({ changeId: expect.any(String), status: "pending", accountLast4: accountNumber.slice(-4), expiresAt: expect.any(String) });
    expect(changeRow(receipt.changeId)).toMatchObject({ status: "pending", requested_by: idsFor("acme").hrAdminId });
    expect(verifiedIds(aliceEmployeeId)).toEqual(before);

    // Payroll runs while the change is pending: Alice is paid into her old verified account.
    const { runId, token } = await approvedRun();
    const outcome = await start(runId, token);
    expect(outcome.status).toBe("computed");
    expect(paidAccount(runId, aliceEmployeeId)).toBe(before[0]);

    // The notice went to Alice's existing address; the link is only there.
    const mail = (await openMailbox(aliceSeed.email, mailboxPasswordFor(aliceSeed.email)))!;
    expect(mail[0].subject).toBe("Confirm the change to your pay account");
    expect(mail[0].body).toContain("requested by your HR administrator");
    expect(mail[0].body).toContain(`ending in ${accountNumber.slice(-4)}`);

    // Alice confirms: one transaction verifies the new account and retires the old one, recording who and when.
    const link = await latestLink(aliceSeed.email);
    expect(link.changeId).toBe(receipt.changeId);
    const confirmed = await decide(alice, "confirm", link);
    expect(confirmed.status).toBe(303);
    expect(location(confirmed)).toBe("/employee?bank=confirmed");
    expect(changeRow(link.changeId)).toMatchObject({ status: "confirmed", resolution: "confirmed", resolved_by: aliceUserId, resolved_at: expect.any(Number) });
    const after = accounts(aliceEmployeeId);
    expect(after.find((a) => a.bank_account_id === before[0])!.status).toBe("retired");
    expect(verifiedIds(aliceEmployeeId)).toHaveLength(1);
    expect(verifiedIds(aliceEmployeeId)[0]).not.toBe(before[0]);
    const confirmedNotice = (await openMailbox(aliceSeed.email, mailboxPasswordFor(aliceSeed.email)))![0];
    expect(confirmedNotice.subject).toBe("Pay account change confirmed");
  });

  it("an HR Admin cannot confirm: the confirm route is for the employee, and the admin never receives the link", async () => {
    const { res } = await adminRequests(aliceEmployeeId);
    const receipt = await res.json();
    expect(JSON.stringify(receipt)).not.toMatch(/token|https?:/);
    const link = await latestLink(aliceSeed.email);
    const verifiedBefore = verifiedIds(aliceEmployeeId);

    // Even holding the real token (as if the mailbox leaked), the admin's session cannot confirm.
    const res2 = await decide(admin, "confirm", link);
    expect(res2.status).toBe(403);
    expect(changeRow(link.changeId).status).toBe("pending");
    expect(verifiedIds(aliceEmployeeId)).toEqual(verifiedBefore);

    // Neither can another employee of the same tenant.
    const res3 = await decide(bob, "confirm", link);
    expect(location(res3)).toBe("/employee?bank=link-invalid");
    await expect(view(link, withTenant("acme", (s) => listUsers(s).find((u) => u.email === bobSeed.email)!.userId))).rejects.toThrow();
    expect(changeRow(link.changeId).status).toBe("pending");
    expect(verifiedIds(aliceEmployeeId)).toEqual(verifiedBefore);

    // Alice can still use it: failed attempts by others do not consume her link. She rejects it.
    const rejected = await decide(alice, "reject", link);
    expect(location(rejected)).toBe("/employee?bank=rejected");
    expect(changeRow(link.changeId)).toMatchObject({ status: "rejected", resolution: "rejected", resolved_by: aliceUserId });
    expect(verifiedIds(aliceEmployeeId)).toEqual(verifiedBefore);
    expect((await openMailbox(aliceSeed.email, mailboxPasswordFor(aliceSeed.email)))![0].subject).toBe("Pay account change rejected");
  });

  it("opening the link (GET) only shows the change; confirming needs a POST", async () => {
    const { accountNumber } = await adminRequests(aliceEmployeeId);
    const link = await latestLink(aliceSeed.email);
    const verifiedBefore = verifiedIds(aliceEmployeeId);

    // What the link page shows on GET: last 4 digits, nothing else, and nothing changes however often it is opened.
    for (let i = 0; i < 3; i++) {
      const shown = await view(link);
      expect(shown).toEqual({
        changeId: link.changeId,
        accountLast4: accountNumber.slice(-4),
        requestedAt: expect.any(String),
        requestedBy: "your HR administrator",
        expiresAt: expect.any(String),
      });
    }
    expect(changeRow(link.changeId).status).toBe("pending");
    expect(verifiedIds(aliceEmployeeId)).toEqual(verifiedBefore);
    expect((db().prepare("SELECT consumed_at FROM verification_code WHERE change_id = ?").get(link.changeId) as { consumed_at: number | null }).consumed_at).toBeNull();

    // The confirm and reject routes have no GET handler (Next.js answers 405), so a scanner or prefetch cannot confirm.
    expect(Object.keys(confirmRoute)).not.toContain("GET");
    expect(Object.keys(rejectRoute)).not.toContain("GET");

    await decide(alice, "reject", link);
  });

  it("refuses a reused link", async () => {
    await aliceRequests();
    const link = await latestLink(aliceSeed.email);
    expect(location(await decide(alice, "confirm", link))).toBe("/employee?bank=confirmed");
    const verifiedAfter = verifiedIds(aliceEmployeeId);
    expect(location(await decide(alice, "confirm", link))).toBe("/employee?bank=link-invalid");
    expect(location(await decide(alice, "reject", link))).toBe("/employee?bank=link-invalid");
    await expect(view(link)).rejects.toThrow();
    expect(changeRow(link.changeId).status).toBe("confirmed");
    expect(verifiedIds(aliceEmployeeId)).toEqual(verifiedAfter);
  });

  it("refuses an expired link", async () => {
    await adminRequests(aliceEmployeeId);
    const link = await latestLink(aliceSeed.email);
    const verifiedBefore = verifiedIds(aliceEmployeeId);
    advance(LINK_TTL_MS / 1000 + 1);
    await signInAll(); // the jump also ends PayrollHub sessions; the link must fail on its own
    expect(location(await decide(alice, "confirm", link))).toBe("/employee?bank=link-invalid");
    await expect(view(link)).rejects.toThrow();
    expect(changeRow(link.changeId).status).toBe("pending");
    expect(verifiedIds(aliceEmployeeId)).toEqual(verifiedBefore);
  });

  it("a new request supersedes the pending one: one pending change per employee, and the old link stops working", async () => {
    const first = await latestLink(aliceSeed.email); // the expired one from the previous test is still pending
    const { accountNumber } = await adminRequests(aliceEmployeeId);
    const second = await latestLink(aliceSeed.email);
    expect(second.changeId).not.toBe(first.changeId);
    expect(changeRow(first.changeId)).toMatchObject({ status: "rejected", resolution: "superseded" });

    await aliceRequests();
    const third = await latestLink(aliceSeed.email);
    expect(changeRow(second.changeId)).toMatchObject({ status: "rejected", resolution: "superseded" });
    const pending = db().prepare("SELECT count(*) AS n FROM bank_account_change WHERE employee_id = ? AND status = 'pending'").get(aliceEmployeeId) as { n: number };
    expect(pending.n).toBe(1);

    const verifiedBefore = verifiedIds(aliceEmployeeId);
    expect(location(await decide(alice, "confirm", second))).toBe("/employee?bank=link-invalid");
    expect(verifiedIds(aliceEmployeeId)).toEqual(verifiedBefore);
    const mail = (await openMailbox(aliceSeed.email, mailboxPasswordFor(aliceSeed.email)))!;
    expect(mail.some((m) => m.body.includes(`ending in ${accountNumber.slice(-4)}) was replaced by a newer request`))).toBe(true);

    // The database also refuses a second pending change.
    const insertPending = () =>
      db().prepare("INSERT INTO bank_account_change SELECT ?, tenant_id, employee_id, requested_by, new_routing_number, new_account_number, 'pending', requested_at, NULL, NULL, NULL FROM bank_account_change WHERE change_id = ?").run(randomUUID(), third.changeId);
    expect(() => withTenant("acme", insertPending)).toThrow(/UNIQUE/);

    expect(location(await decide(alice, "reject", third))).toBe("/employee?bank=rejected");
  });

  it("refuses a link from another tenant", async () => {
    await adminRequests(aliceEmployeeId);
    const link = await latestLink(aliceSeed.email);
    const verifiedBefore = verifiedIds(aliceEmployeeId);
    // Dana (globex) presents Alice's link under her own tenant: the code does not exist in globex's scope.
    expect(location(await decide(dana, "confirm", link, "globex"))).toBe("/employee?bank=link-invalid");
    // Under acme's path, her globex session is refused before any lookup.
    expect((await decide(dana, "confirm", link, "acme")).status).toBe(403);
    expect(changeRow(link.changeId).status).toBe("pending");
    expect(verifiedIds(aliceEmployeeId)).toEqual(verifiedBefore);
    await decide(alice, "reject", link);
  });

  it("refuses a forged cross-site confirm", async () => {
    await adminRequests(aliceEmployeeId);
    const link = await latestLink(aliceSeed.email);
    const verifiedBefore = verifiedIds(aliceEmployeeId);
    // A form on another site posting to the confirm route with Alice's session: the Origin check refuses it.
    expect((await decide(alice, "confirm", link, "acme", { origin: "https://evil.example" })).status).toBe(403);
    // And a browser would not even send the session cookie (SameSite=Strict): without it, nothing is confirmed.
    const anonymous = await decide(new Browser(), "confirm", link);
    expect([401, 403, 303]).toContain(anonymous.status);
    expect(location(anonymous)).not.toBe("/employee?bank=confirmed");
    expect(changeRow(link.changeId).status).toBe("pending");
    expect(verifiedIds(aliceEmployeeId)).toEqual(verifiedBefore);
    await decide(alice, "reject", link);
  });
});

describe("L2-11: the mailbox is a separate channel", () => {
  const openAs = async (browser: Browser, address: string, password: string) =>
    seen(await browser.post(outboxRoute.POST, "/dev/outbox/view", { address, password }));

  it("only the mailbox's own password opens it; PayrollHub sessions and passwords do not", async () => {
    const wrong = [
      [admin, aliceSeed.email, acme.hrAdmin.password], // the admin's PayrollHub password
      [admin, aliceSeed.email, mailboxPasswordFor(acme.hrAdmin.email)], // the admin's own mailbox password
      [bob, aliceSeed.email, mailboxPasswordFor(bobSeed.email)], // another employee's mailbox password
      [alice, aliceSeed.email, aliceSeed.idpPassword], // Alice's IdP password is not her mailbox password
      [admin, aliceSeed.email, ""],
      [new Browser(), "nobody@acme.test", "anything"],
    ] as const;
    for (const [browser, address, password] of wrong) {
      const res = await openAs(browser, address, password);
      expect(res.status).toBe(401);
      expect(await res.text()).not.toContain("/employee/bank-change/");
    }
    // Nothing to browse: no GET, no listing of mailboxes.
    expect(Object.keys(outboxRoute)).toEqual(["POST"]);

    const own = await openAs(new Browser(), aliceSeed.email, mailboxPasswordFor(aliceSeed.email));
    expect(own.status).toBe(200);
    expect(own.headers.get("cache-control")).toBe("no-store");
    expect(await own.text()).toContain("/employee/bank-change/");
  });

  it("D30: mailbox passwords are random per install, not derivable from anything an HR Admin knows", () => {
    const passwords = SEED_TENANTS.flatMap((t) => [t.hrAdmin.email, t.approver.email, ...t.employees.map((e) => e.email)]).map(mailboxPasswordFor);
    expect(new Set(passwords).size).toBe(passwords.length);
    for (const p of passwords) {
      expect(p).toMatch(/^[A-Za-z0-9_-]{24}$/); // 18 random bytes, base64url
      expect(p).not.toMatch(/Mailbox|Dev-2026|alice|bob|admin/i);
    }
    // The file is the only place they are written, and it is owner-only (where the platform supports modes).
    if (process.platform !== "win32") expect(statSync(process.env.DEV_CREDENTIALS_FILE!).mode & 0o077).toBe(0);
  });

  it("a user's contact email cannot be changed to redirect confirmations", () => {
    expect(() => db().prepare("UPDATE app_user SET email = 'attacker@evil.example' WHERE user_id = ?").run(aliceUserId)).toThrow(/cannot be changed/);
  });
});

describe("L2-11: validation and last-4-only output", () => {
  it("rejects an invalid routing number or account number, storing nothing", async () => {
    const before = changeCount(aliceEmployeeId);
    const bad = await adminRequests(aliceEmployeeId, "555512345678", "123456789");
    expect(bad.res.status).toBe(400);
    expect((await bad.res.json()).error).toBe("Routing number is not a valid ABA routing number");
    const badAccount = await adminRequests(aliceEmployeeId, "12ab5678");
    expect(badAccount.res.status).toBe(400);
    const own = await aliceRequests("555512345678", "021000022");
    expect(location(own.res)).toBe("/employee?bank=invalid");
    expect(changeCount(aliceEmployeeId)).toBe(before);

    for (const valid of ["011000015", "021000021", "026009593", NEW_ROUTING, OTHER_ROUTING]) expect(isValidRoutingNumber(valid)).toBe(true);
    for (const invalid of ["123456789", "021000022", "000000000", "02100002", "0210000210", "02100002a", " 21000021"]) expect(isValidRoutingNumber(invalid)).toBe(false);
    for (const valid of ["1234", "12345678901234567"]) expect(isValidAccountNumber(valid)).toBe(true);
    for (const invalid of ["123", "123456789012345678", "0000", "12-34", "1234 "]) expect(isValidAccountNumber(invalid)).toBe(false);
  });

  it("an HR Admin's request for another tenant's employee is refused", async () => {
    const danaEmployeeId = employeeIdFor("globex", danaSeed.email);
    const before = changeCount(danaEmployeeId);
    const { res } = await adminRequests(danaEmployeeId);
    expect(res.status).toBe(404);
    expect(changeCount(danaEmployeeId)).toBe(before);
  });
});

describe("D28 with Layer 7: confirming a change after approval invalidates the approval", () => {
  it("a change pending at approval does not matter; confirming it after approval fails the run until re-approved", async () => {
    const { accountNumber } = await adminRequests(aliceEmployeeId);
    const link = await latestLink(aliceSeed.email);
    const oldAccount = verifiedIds(aliceEmployeeId)[0];

    const { runId, token } = await approvedRun();
    expect(location(await decide(alice, "confirm", link))).toBe("/employee?bank=confirmed");
    const newAccount = verifiedIds(aliceEmployeeId)[0];
    expect(newAccount).not.toBe(oldAccount);

    const failed = await start(runId, token).catch((e: unknown) => e);
    expect(failed).toBeInstanceOf(RunFailedError);
    expect((failed as RunFailedError).reason).toBe("content_changed");
    expect((db().prepare("SELECT count(*) AS n FROM pay_result WHERE run_id = ?").get(runId) as { n: number }).n).toBe(0);

    // Re-approved, the run pays the account Alice confirmed.
    advance(31);
    const again = await approver.json(approvePOST, `/api/tenants/acme/runs/${runId}/approve`, { code: totpNow(acme.approver.totpSecret) }, { tenantId: "acme", runId });
    expect(again.status).toBe(200);
    await start(runId, (await again.json()).approvalToken);
    expect(paidAccount(runId, aliceEmployeeId)).toBe(newAccount);
    const summary = await getBankSummary(await mintAsBff("bankAccount.summary", "acme"), { tenantId: "acme", employeeUserId: aliceUserId });
    expect(summary.current?.accountLast4).toBe(accountNumber.slice(-4));
  });

  // Last: checks everything this file produced.
  it("no full account or routing number appears in any response, notice, or log", async () => {
    const mailboxes = await Promise.all(
      [aliceSeed.email, bobSeed.email, acme.hrAdmin.email].map(async (a) => JSON.stringify(await openMailbox(a, mailboxPasswordFor(a)))),
    );
    const output = [...responses, ...logged, ...mailboxes].join("\n");
    expect(responses.length).toBeGreaterThan(20);
    expect(output).toContain(NEW_ACCOUNTS[0].slice(-4));
    const fullNumbers = [
      ...NEW_ACCOUNTS.slice(0, nextAccount),
      "555512345678",
      NEW_ROUTING,
      OTHER_ROUTING,
      "123456789",
      ...SEED_TENANTS.flatMap((t) => t.employees.flatMap((e) => [e.accountNumber, e.routingNumber])),
    ];
    for (const n of fullNumbers) expect(output, `full number ${n.slice(-4)} leaked`).not.toContain(n);
  });
});
