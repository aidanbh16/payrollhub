import { expect, test, type BrowserContext, type Page } from "@playwright/test";
import { E2E_ORIGIN } from "./env";
import { SEEDED_NUMBERS, daysFromToday, freshCode, mailboxPassword, screenshot, signInEmployee, signInStaff, totp } from "./helpers";

// Layer 9 acceptance, in a real browser (Chromium) against `next start` and the stand-in bank, from a clean seed:
// sign in with MFA, create a run, approve it with step-up, run payroll, send to bank; as an employee, request a bank
// change and confirm it through the mailbox. Then the browser-level checks. One context per person, signed in once.

test.describe.configure({ mode: "serial" });

let admin: BrowserContext;
let approver: BrowserContext;
let alice: BrowserContext;
let bob: BrowserContext;
let adminPage: Page;
let runId = "";
const payDate = daysFromToday(14);

/** No seeded account or routing number in the page's HTML. */
async function expectNoFullNumbers(page: Page) {
  const html = await page.content();
  for (const n of SEEDED_NUMBERS) expect(html, `full number ending ${n.slice(-4)} on ${page.url()}`).not.toContain(n);
}

test.beforeAll(async ({ browser }) => {
  [admin, approver, alice, bob] = await Promise.all([1, 2, 3, 4].map(() => browser.newContext()));
});

test.afterAll(async () => {
  await Promise.all([admin, approver, alice, bob].map((c) => c.close()));
});

test("[L2-01 DiD] [L2-11 DiD] the full flow: MFA sign-in, draft run, step-up approval, run payroll, send to bank, employee bank change", async () => {
  // --- HR Admin: sign in with MFA, see employees (last 4 only), create a draft run ---
  adminPage = await admin.newPage();
  await adminPage.goto("/login");
  await screenshot(adminPage, "sign-in");
  await signInStaff(adminPage, "admin@acme.test", "/admin");
  await expect(adminPage.getByTestId("employee-alice@acme.test")).toContainText("ending in 0101");
  await expectNoFullNumbers(adminPage);
  await adminPage.getByLabel("Pay date").fill(payDate);
  await adminPage.getByRole("button", { name: "Create draft run" }).click();
  await expect(adminPage.getByText(`Draft run created for ${payDate}`)).toBeVisible();
  await screenshot(adminPage, "hr-admin-console");

  // --- Approver: review, approve with a fresh step-up code, run payroll ---
  const ap = await approver.newPage();
  await signInStaff(ap, "approver@acme.test", "/approver");
  await ap.getByRole("row", { name: new RegExp(payDate) }).getByRole("link", { name: "Review" }).click();
  await expect(ap.getByTestId("run-status")).toHaveText("draft");
  runId = ap.url().split("/").pop()!;
  await ap.getByLabel("Authenticator code").fill(await freshCode("approver@acme.test"));
  const approved = ap.waitForResponse((r) => r.url().endsWith(`/runs/${runId}/approve`));
  await ap.getByRole("button", { name: "Approve" }).click();
  const { approvalToken } = await (await approved).json();
  await expect(ap.getByRole("button", { name: "Run payroll" })).toBeVisible();

  // The approval token is in React state only: not in any browser storage or cookie.
  const stored = await ap.evaluate(async () => ({
    local: JSON.stringify({ ...localStorage }),
    session: JSON.stringify({ ...sessionStorage }),
    cookie: document.cookie,
    indexedDb: (await indexedDB.databases()).map((d) => d.name ?? ""),
  }));
  const allCookies = JSON.stringify(await approver.cookies());
  const [header, payload, signature] = approvalToken.split(".");
  for (const piece of [approvalToken, payload, signature]) {
    for (const place of [stored.local, stored.session, stored.cookie, allCookies]) expect(place).not.toContain(piece);
  }
  expect(stored.indexedDb).toEqual([]);
  expect(header.length).toBeGreaterThan(10);
  await screenshot(ap, "approved-token-in-memory");

  await ap.getByRole("button", { name: "Run payroll" }).click();
  await expect(ap.getByTestId("run-status")).toHaveText("computed");
  await expect(ap.getByTestId("totals")).toContainText("$9,416.67");
  await expect(ap.getByTestId("totals")).toContainText("$7,345.00");
  await expect(ap.getByText("No exceptions: every active employee is paid.")).toBeVisible();
  await expect(ap.getByText("Late (D29)")).toHaveCount(0);
  await expectNoFullNumbers(ap);
  await screenshot(ap, "approver-review-computed");

  // --- Approver: send to bank (D33) ---
  await ap.getByRole("button", { name: "Send to bank" }).click();
  await expect(ap.getByText(/Sent to the bank: 3 payment\(s\), \$7,345\.00\. Bank reference BANK-/)).toBeVisible();
  await expect(ap.getByTestId("run-status")).toHaveText("disbursed");
  await screenshot(ap, "sent-to-bank");

  // --- Employee: own statement, then a bank change confirmed through the mailbox ---
  const ep = await alice.newPage();
  await signInEmployee(ep, "alice@acme.test");
  await expect(ep.getByRole("row", { name: new RegExp(payDate) })).toContainText("$2,437.50");
  await ep.getByRole("row", { name: new RegExp(payDate) }).getByRole("link", { name: "View statement" }).click();
  await expect(ep.getByTestId("statement")).toContainText("$3,125.00");
  await expect(ep.getByTestId("statement")).toContainText("$687.50");
  await expect(ep.getByTestId("statement")).toContainText("account ending in 0101");
  await screenshot(ep, "employee-statement");
  await ep.goto("/employee");
  await ep.getByLabel("Routing number").fill("091000019");
  await ep.getByLabel("Account number").fill("555500001234");
  await ep.getByRole("button", { name: "Request change" }).click();
  await expect(ep.getByText(/Change requested/)).toBeVisible();
  await expect(ep.getByTestId("pay-account")).toContainText("Account ending in 0101");
  await expect(ep.getByTestId("pay-account")).toContainText("ending in 1234");
  await expect(ep.getByTestId("pay-account")).toContainText("unverified");
  await screenshot(ep, "employee-change-pending");

  // The HR Admin sees it as unverified too.
  await adminPage.reload();
  await expect(adminPage.getByTestId("employee-alice@acme.test")).toContainText("unverified");

  // The mailbox: the stand-in for Alice's own email, opened with her mailbox password.
  await ep.goto("/dev/outbox");
  await ep.getByLabel("Email address").fill("alice@acme.test");
  await ep.getByLabel("Mailbox password").fill(mailboxPassword("alice@acme.test"));
  await ep.getByRole("button", { name: "Open mailbox" }).click();
  const link = await ep.getByRole("link", { name: /\/employee\/bank-change\// }).first().getAttribute("href");
  expect(link).toMatch(/token=/);
  await screenshot(ep, "mailbox");

  // The confirmation page: no Referer, nothing from any other origin, token moved out of the address bar.
  const requests: { url: string; referer?: string }[] = [];
  ep.on("request", (r) => requests.push({ url: r.url(), referer: r.headers()["referer"] }));
  const doc = await ep.goto(link!);
  expect(doc!.headers()["referrer-policy"]).toBe("no-referrer");
  await expect(ep.getByTestId("new-last4")).toHaveText("1234");
  expect(ep.url()).not.toContain("token=");
  await screenshot(ep, "confirm-change");
  expect(requests.filter((r) => !r.url.startsWith(E2E_ORIGIN))).toEqual([]);
  expect(requests.filter((r) => r.referer)).toEqual([]);
  // Following a link from this page to another site sends no Referer.
  const external: Record<string, string>[] = [];
  await alice.route("http://external.example/**", async (route) => {
    external.push(route.request().headers());
    await route.fulfill({ status: 200, body: "ok" });
  });
  const popup = alice.waitForEvent("page");
  await ep.evaluate(() => {
    const a = document.createElement("a");
    a.href = "http://external.example/landing";
    a.target = "_blank";
    a.textContent = "external";
    document.body.appendChild(a);
    a.click();
  });
  await (await popup).waitForLoadState();
  expect(external).toHaveLength(1);
  expect(external[0]["referer"]).toBeUndefined();

  await ep.getByRole("button", { name: "Confirm new account" }).click();
  await expect(ep).toHaveURL(/\/employee\?bank=confirmed$/);
  await expect(ep.getByTestId("pay-account")).toContainText("Account ending in 1234");
  await expect(ep.getByTestId("pay-account")).not.toContainText("unverified");
  await adminPage.reload();
  await expect(adminPage.getByTestId("employee-alice@acme.test")).toContainText("ending in 1234");
});

test("[L0-11 DiD] D29: the approver's review shows the late flag", async () => {
  // The review API's late flag is covered by tests/threats/L0-01-route-groups.test.ts with a moved clock; here, the UI
  // renders it when the API says so.
  const page = await approver.newPage();
  await page.route(`**/api/tenants/acme/runs/${runId}/review`, async (route) => {
    const res = await route.fetch();
    const body = await res.json();
    await route.fulfill({ response: res, json: { ...body, run: { ...body.run, late: true } } });
  });
  await page.goto(`/approver/runs/${runId}`);
  await expect(page.getByText("Late (D29):")).toBeVisible();
  await screenshot(page, "late-flag");
  await page.close();
});

test("[L0-01 DiD] an employee session is refused on every console page and console API", async () => {
  const page = await alice.newPage();
  for (const path of ["/admin", "/approver", `/approver/runs/${runId}`]) {
    await page.goto(path);
    await expect(page).toHaveURL(/\/employee$/);
    await expect(page.getByRole("heading", { name: "Employee portal" })).toBeVisible();
  }
  const api = page.request;
  const base = "/api/tenants/acme";
  const calls = [
    api.get(`${base}/runs`),
    api.get(`${base}/runs/${runId}`),
    api.get(`${base}/runs/${runId}/review`),
    api.get(`${base}/employees`),
    api.get("/api/admin/me"),
    api.post(`${base}/runs`, { data: { payDate } }),
    api.post(`${base}/runs/${runId}/approve`, { data: { code: "123456" } }),
    api.post(`${base}/runs/${runId}/start`, { data: { approvalToken: "x" } }),
    api.post(`${base}/runs/${runId}/disburse`, { data: {} }),
    api.post(`${base}/employees/00000000-0000-4000-8000-000000000000/bank-account/changes`, { data: { routingNumber: "091000019", accountNumber: "1234567" } }),
  ];
  const statuses = await Promise.all(calls.map(async (c) => (await c).status()));
  expect(statuses).toEqual(Array(calls.length).fill(403));
  await page.close();
});

test("[L0-01 DiD] one employee cannot view another's pay statement by changing the id in the URL", async () => {
  const bp = await bob.newPage();
  await signInEmployee(bp, "bob@acme.test");
  const bobs = await (await bp.request.get("/api/tenants/acme/me/pay-statements")).json();
  const bobResult = bobs.statements.find((s: { payDate: string }) => s.payDate === payDate);
  expect(bobResult.netPayCents).toBe(224_250);

  const page = await alice.newPage();
  await page.goto(`/employee/statements/${bobResult.resultId}`);
  await expect(page.getByText("Statement not found.")).toBeVisible();
  await expect(page.locator("body")).not.toContainText("$2,242.50");
  expect((await page.request.get(`/api/tenants/acme/me/pay-statements/${bobResult.resultId}`)).status()).toBe(404);
  await screenshot(page, "idor-refused");
  await page.close();
  await bp.close();
});

test("[L2-01 DiD] [L0-01 DiD] security headers are present, and the CSP blocks an injected inline script", async () => {
  const page = await approver.newPage();
  const doc = await page.goto("/approver");
  const h = doc!.headers();
  expect(h["content-security-policy"]).toMatch(/script-src 'self' 'nonce-[A-Za-z0-9+/=]+';/);
  expect(h["content-security-policy"]).toContain("frame-ancestors 'none'");
  expect(h["content-security-policy"]).not.toMatch(/unsafe-inline|unsafe-eval|strict-dynamic/);
  expect(h).toMatchObject({ "x-content-type-options": "nosniff", "x-frame-options": "DENY", "referrer-policy": "no-referrer", "cache-control": "no-store" });
  expect((await page.request.get("/api/tenants/acme/runs")).headers()["cache-control"]).toBe("no-store");
  // Every script the page itself rendered carries the nonce.
  expect(await page.$$eval("script", (els) => els.filter((e) => !e.nonce).length)).toBe(0);

  // Injected markup (as a server-side XSS would arrive): an inline script and an inline event handler, no nonce.
  const injected = await approver.newPage();
  const violations: string[] = [];
  injected.on("console", (m) => /Content Security Policy/.test(m.text()) && violations.push(m.text()));
  await injected.route(`${E2E_ORIGIN}/approver`, async (route) => {
    const res = await route.fetch();
    const html = (await res.text()).replace("</body>", '<script>window.__pwned = true</script><img src="/x" onerror="window.__pwned2 = true"></body>');
    await route.fulfill({ response: res, body: html });
  });
  await injected.goto("/approver");
  await expect(injected.getByRole("heading", { name: "Payroll Approver console" })).toBeVisible();
  // And a script inserted at run time.
  await injected.evaluate(() => {
    const s = document.createElement("script");
    s.textContent = "window.__pwned3 = true";
    document.body.appendChild(s);
  });
  await injected.waitForTimeout(300);
  expect(await injected.evaluate(() => [Boolean((window as never)["__pwned"]), Boolean((window as never)["__pwned2"]), Boolean((window as never)["__pwned3"])])).toEqual([false, false, false]);
  expect(violations.length).toBeGreaterThanOrEqual(3);
  await page.close();
  await injected.close();
});

test("the TOTP helper works from a clean seed", async () => {
  // Every sign-in and the approval step-up above used it; here, its two documented output forms.
  expect(totp("admin@globex.test", false)).toMatch(/^\d{6} {3}\(admin@globex\.test, organization globex; valid for \d+ more seconds\)$/);
  expect(totp("approver@globex.test")).toMatch(/^\d{6}$/);
});

// Last: signs the HR Admin out.
test("[L0-01 DiD] after sign-out, the back button shows nothing sensitive", async () => {
  await adminPage.goto("/admin");
  await expect(adminPage.getByTestId("employee-alice@acme.test")).toBeVisible();
  await adminPage.getByRole("button", { name: "Sign out" }).click();
  await expect(adminPage).toHaveURL(/\/login$/);
  await adminPage.goBack();
  await adminPage.waitForLoadState("load");
  await expect(adminPage).toHaveURL(/\/login$/);
  const body = await adminPage.locator("body").innerText();
  expect(body).not.toMatch(/Alice Anders|ending in|HR Admin console|admin@acme\.test/);
  await screenshot(adminPage, "back-after-sign-out");
});
