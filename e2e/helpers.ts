import { execSync } from "node:child_process";
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, type Page } from "@playwright/test";
import { E2E_ENV, childEnv } from "./env";

// Helpers that act like a tester: credentials come only from the development credentials file that db:reset wrote,
// and authenticator codes from the documented `npm run totp` script.

const ROOT = join(__dirname, "..");

function records(kind: string): string[][] {
  return readFileSync(join(ROOT, E2E_ENV.DEV_CREDENTIALS_FILE), "utf8")
    .split("\n")
    .map((l) => l.split("\t"))
    .filter((f) => f[0] === kind);
}

export const staff = (email: string) => {
  const f = records("staff").find((r) => r[2] === email)!;
  return { organization: f[1], email, password: f[4] };
};
export const employee = (email: string) => {
  const f = records("employee").find((r) => r[2] === email)!;
  return { organization: f[1], email, password: f[3] };
};
export const mailboxPassword = (email: string) => records("mailbox").find((r) => r[1] === email)![2];

/** Every seeded account and routing number, read from the seed source: none may ever appear on a page. */
export const SEEDED_NUMBERS = [...readFileSync(join(ROOT, "scripts/lib/seed.ts"), "utf8").matchAll(/(?:routingNumber|accountNumber): "(\d+)"/g)].map((m) => m[1]);

/** The documented helper: npm run totp -- <email>. */
export function totp(email: string, codeOnly = true): string {
  return execSync(`npm run -s totp -- ${email}${codeOnly ? " --code-only" : ""}`, { cwd: ROOT, env: childEnv() as NodeJS.ProcessEnv, encoding: "utf8" }).trim();
}

const lastCode = new Map<string, string>();
/** A code not used before by this account (the server accepts each 30-second step once): waits for the next step. */
export async function freshCode(email: string): Promise<string> {
  for (let i = 0; i < 40; i++) {
    const code = totp(email);
    if (code !== lastCode.get(email)) {
      lastCode.set(email, code);
      return code;
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error("no fresh TOTP code");
}

export async function signInStaff(page: Page, email: string, home: "/admin" | "/approver") {
  const s = staff(email);
  await page.goto("/login");
  const form = page.locator('form[action="/api/auth/login"]');
  await form.getByLabel("Organization id").fill(s.organization);
  await form.getByLabel("Email").fill(s.email);
  await form.getByLabel("Password").fill(s.password);
  await form.getByRole("button", { name: "Continue" }).click();
  await expect(page).toHaveURL(/\/login\/mfa$/);
  await page.getByLabel("Code").fill(await freshCode(email));
  await page.getByRole("button", { name: "Verify" }).click();
  await expect(page).toHaveURL(new RegExp(`${home}$`));
}

export async function signInEmployee(page: Page, email: string) {
  const e = employee(email);
  await page.goto("/login");
  const form = page.locator('form[action="/api/auth/sso/start"]');
  await form.getByLabel("Organization id").fill(e.organization);
  await form.getByRole("button", { name: "Sign in with your organization" }).click();
  await page.getByLabel("Email").fill(e.email);
  await page.getByLabel("Password").fill(e.password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.getByRole("button", { name: "Continue to PayrollHub" }).click();
  await expect(page).toHaveURL(/\/employee$/);
}

const SHOTS = join(ROOT, ".data", "e2e", "screenshots");
let shot = 0;
/** Full-page screenshot of a walkthrough step, into .data/e2e/screenshots (inside the project; gitignored). */
export async function screenshot(page: Page, name: string) {
  mkdirSync(SHOTS, { recursive: true });
  await page.screenshot({ path: join(SHOTS, `${String(++shot).padStart(2, "0")}-${name}.png`), fullPage: true });
}

/** A date `days` from today (UTC, as the server checks pay dates). */
export const daysFromToday = (days: number) => new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);
