import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { NextRequest } from "next/server";
import { describe, expect, it } from "vitest";
import { POST as loginPOST } from "@/app/api/auth/login/route";
import { POST as mfaPOST } from "@/app/api/auth/mfa/route";
import { deleteDatabase, migrateDatabase } from "@/data/db/migrate";
import { contentSecurityPolicy } from "@/edge/security-headers";
import nextConfig from "@/next.config";
import { proxy } from "@/proxy";
import { currentTotp, readStaffCredential } from "@/scripts/lib/dev-credentials";
import { SEED_TENANTS, SERVICE_GRANTS, mailboxPasswordFor, seedDatabase, seededPassword, seededTotpSecret } from "@/scripts/lib/seed";
import { ServiceAuthError } from "@/services/errors";
import { mintServiceToken, type ServiceName } from "@/services/identity/service-tokens";
import { setupSeededDatabase } from "../helpers/database";
import { Browser } from "../helpers/http";

// Layer 9: browser-level headers from Proxy, the UI's import boundary, DV-43's full-number restriction, and the tester
// credentials (TOTP helper) from a clean seed.

setupSeededDatabase();

const ROOT = join(__dirname, "..", "..");
function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) {
      if (!["node_modules", ".next", ".git", ".data"].includes(name)) sourceFiles(path, out);
    } else if (/\.(ts|tsx)$/.test(name)) out.push(relative(ROOT, path).split(sep).join("/"));
  }
  return out;
}
const appCode = ["app", "application", "services", "edge", "data", "partners", "config"].flatMap((d) => sourceFiles(join(ROOT, d)));
const read = (file: string) => readFileSync(join(ROOT, file), "utf8");
/** Value imports only: `import type ...` and inline `type` specifiers are compile-time and leave no code behind. */
const valueImports = (source: string) =>
  [...source.matchAll(/^import\s+(?!type\s)([\s\S]*?)\s+from\s+["']([^"']+)["']/gm)].filter((m) => !/^\{\s*(type\s+\w+\s*,?\s*)+\}$/.test(m[1])).map((m) => m[2]);

describe("[L0-01 DiD] [L2-01 DiD] Browser security headers (Proxy)", () => {
  it("every page gets a fresh nonce-based CSP with no unsafe-inline, unsafe-eval, or strict-dynamic, and no-store", async () => {
    const nonces = new Set<string>();
    for (const path of ["/login", "/admin", "/employee/bank-change/00000000-0000-4000-8000-000000000000?token=abc"]) {
      const res = await proxy(new NextRequest(`http://localhost:3000${path}`));
      const csp = res.headers.get("content-security-policy")!;
      const nonce = /'nonce-([A-Za-z0-9+/=]+)'/.exec(csp)![1];
      nonces.add(nonce);
      expect(csp).toContain(`script-src 'self' 'nonce-${nonce}';`);
      expect(csp).toContain("frame-ancestors 'none'");
      expect(csp).toContain("default-src 'self'");
      expect(csp).not.toMatch(/unsafe-inline|unsafe-eval|strict-dynamic|https?:|\*/);
      expect(res.headers.get("cache-control")).toBe("no-store");
    }
    expect(nonces.size).toBe(3);
    // In development only, React needs eval; production never gets it.
    expect(contentSecurityPolicy("n", true)).toContain("'unsafe-eval'");
    expect(contentSecurityPolicy("n", false)).not.toContain("'unsafe-eval'");
  });

  it("every response also gets nosniff, no framing, and no Referer (next.config.ts)", async () => {
    const rules = await nextConfig.headers!();
    const all = Object.fromEntries(rules.find((r) => r.source === "/:path*")!.headers.map((h) => [h.key, h.value]));
    expect(all).toMatchObject({ "X-Content-Type-Options": "nosniff", "X-Frame-Options": "DENY", "Referrer-Policy": "no-referrer" });
  });
});

describe("[L0-01 DiD] [L2-01 DiD] The UI calls only the route handlers", () => {
  const ui = sourceFiles(join(ROOT, "app")).filter((f) => !f.startsWith("app/api/") && !f.startsWith("app/mock-idp/") && !/\/route\.ts$/.test(f));

  it("no page or component imports services, data, partners, edge code, or token minting", () => {
    expect(ui.length).toBeGreaterThan(10);
    const offenders = ui.flatMap((file) =>
      valueImports(read(file))
        .filter((m) => /^@\/(services|data|partners|edge)\/|^@\/application\/(mint-as-|http\/)/.test(m))
        .map((m) => `${file}: ${m}`),
    );
    expect(offenders).toEqual([]);
  });

  it("nothing renders raw HTML (no dangerouslySetInnerHTML)", () => {
    expect(appCode.filter((f) => /dangerouslySetInnerHTML\s*[=:]/.test(read(f)))).toEqual([]);
  });
});

describe("[L1-19 DiD] [L2-11 DiD] DV-43: full account numbers reach ACH Disbursement only", () => {
  it("only Bank Account imports its repository, and only ACH imports the payable-account reader", () => {
    const repoImports = appCode.filter((f) => !f.startsWith("services/bank-account/") && /from\s+["'][^"']*services\/bank-account\/repository["']/.test(read(f)));
    const payableImports = appCode.filter(
      (f) => !f.startsWith("services/bank-account/") && !f.startsWith("services/ach/") && /\b(openPayableAccountReader|readPayableAccounts)\b/.test(read(f)),
    );
    expect(repoImports).toEqual([]);
    expect(payableImports).toEqual([]);
  });

  it("ServiceGrant lets only ACH reach bankAccount.readPayable; every other caller is refused a token", async () => {
    expect(SERVICE_GRANTS.filter((g) => g.endpoint === "bankAccount.readPayable").map((g) => g.caller)).toEqual(["ach"]);
    for (const caller of ["bff", "engine", "approval", "bank-account", "identity"] as ServiceName[]) {
      await expect(mintServiceToken({ caller, endpoint: "bankAccount.readPayable", tenantId: "acme" })).rejects.toBeInstanceOf(ServiceAuthError);
    }
    await expect(mintServiceToken({ caller: "ach", endpoint: "bankAccount.readPayable", tenantId: "acme" })).resolves.toEqual(expect.any(String));
  });
});

describe("Tester credentials from a clean seed", () => {
  it("the credentials file lists every staff account with its TOTP secret and otpauth link, and the TOTP helper's code signs in", async () => {
    for (const t of SEED_TENANTS) {
      for (const staff of [t.hrAdmin, t.approver]) {
        const cred = readStaffCredential(staff.email);
        expect(cred).toMatchObject({ organization: t.tenantId, password: seededPassword(staff.email), totpSecret: seededTotpSecret(staff.email) });
        expect(cred.otpauth).toMatch(new RegExp(`^otpauth://totp/.+\\?secret=${seededTotpSecret(staff.email)}&issuer=PayrollHub`));
      }
      for (const e of t.employees) expect(mailboxPasswordFor(e.email)).toMatch(/^[A-Za-z0-9_-]{24}$/);
    }
    // Sign in exactly as a tester would: the file's password, then the helper's current code.
    const { organization, password } = readStaffCredential("admin@globex.test");
    const browser = new Browser();
    expect((await browser.post(loginPOST, "/api/auth/login", { organization, email: "admin@globex.test", password })).status).toBe(303);
    const res = await browser.post(mfaPOST, "/api/auth/mfa", { code: currentTotp("admin@globex.test").code });
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toMatch(/\/admin$/);
  });

  it("[L0-01 DiD] staff TOTP secrets are random per install: a new seed writes new secrets, and none is in the source or README", async () => {
    const emails = SEED_TENANTS.flatMap((t) => [t.hrAdmin.email, t.approver.email]);
    const before = emails.map(seededTotpSecret);
    for (const secret of before) expect(secret).toMatch(/^[A-Z2-7]{32}$/); // 160 bits, base32
    expect(new Set(before).size).toBe(emails.length);
    deleteDatabase();
    migrateDatabase();
    await seedDatabase();
    const after = emails.map(seededTotpSecret);
    after.forEach((secret, i) => expect(secret).not.toBe(before[i]));
    // No fixed secret left behind: no 32-character base32 literal in the seed, and none listed in the README.
    expect(read("scripts/lib/seed.ts")).not.toMatch(/["'][A-Z2-7]{32}["']/);
    expect(read("README.md")).not.toMatch(/\b[A-Z2-7]{32}\b/);
  });

  it("[L0-01 DiD] staff passwords are random per install: a new seed writes new passwords, and none is in the source or README", async () => {
    const emails = SEED_TENANTS.flatMap((t) => [t.hrAdmin.email, t.approver.email]);
    const before = emails.map(seededPassword);
    for (const password of before) expect(password).toMatch(/^[A-Za-z0-9_-]{24}$/); // 144 bits
    expect(new Set(before).size).toBe(emails.length);
    deleteDatabase();
    migrateDatabase();
    await seedDatabase();
    const after = emails.map(seededPassword);
    after.forEach((password, i) => expect(password).not.toBe(before[i]));
    // The old password no longer signs in; the new one does (step 1 answers the same either way, so check the MFA step).
    const browser = new Browser();
    await browser.post(loginPOST, "/api/auth/login", { organization: "acme", email: emails[0], password: before[0] });
    const refused = await browser.post(mfaPOST, "/api/auth/mfa", { code: currentTotp(emails[0]).code });
    expect(refused.headers.get("location")).toMatch(/\/login\?error=signin$/);
    // No staff password in the seed, the README, or any staff record of the source: no "password:" literal for staff.
    expect(read("scripts/lib/seed.ts")).not.toMatch(/(Admin|Approver)-Dev-\d{4}!/);
    expect(read("README.md")).not.toMatch(/(Admin|Approver)-Dev-\d{4}!/);
    for (const password of [...before, ...after]) {
      expect(read("README.md")).not.toContain(password);
      expect(read("scripts/lib/seed.ts")).not.toContain(password);
    }
  });
});
