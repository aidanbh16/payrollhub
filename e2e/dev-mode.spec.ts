import { expect, test } from "@playwright/test";
import { E2E_DEV_ORIGIN } from "./env";
import { mailboxPassword, signInEmployee } from "./helpers";

// Turn 15 (clean-install check): the README's step 7 runs `npm run dev`, but the other browser tests use the
// production build. Under `next dev`, React Strict Mode runs effects twice; the bank-change confirmation page used to
// read its token from the address bar on each run, and the second run found it already removed, so the page showed
// "Open the confirmation link" instead of the change. This walks README section 5, step 8, against `next dev`.
test.use({ baseURL: E2E_DEV_ORIGIN });

test("[L2-11 DiD] under npm run dev, the employee confirms a bank change from the mailbox link (README section 5, step 8)", async ({ page }) => {
  await signInEmployee(page, "bob@acme.test");
  await page.getByLabel("Routing number").fill("122105278");
  await page.getByLabel("Account number").fill("555500009876");
  await page.getByRole("button", { name: "Request change" }).click();
  await expect(page.getByTestId("pay-account")).toContainText("unverified");

  await page.goto("/dev/outbox");
  await page.getByLabel("Email address").fill("bob@acme.test");
  await page.getByLabel("Mailbox password").fill(mailboxPassword("bob@acme.test"));
  await page.getByRole("button", { name: "Open mailbox" }).click();
  // Links in mail point at APP_ORIGIN (the production-build server of this run); open the same path on the dev server.
  const link = new URL((await page.getByRole("link", { name: /\/employee\/bank-change\// }).first().getAttribute("href"))!);
  await page.goto(link.pathname + link.search);

  await expect(page.getByTestId("new-last4")).toHaveText("9876");
  expect(page.url()).not.toContain("token=");
  await page.getByRole("button", { name: "Confirm new account" }).click();
  await expect(page).toHaveURL(/\/employee\?bank=confirmed$/);
  await expect(page.getByTestId("pay-account")).toContainText("Account ending in 9876");
});
