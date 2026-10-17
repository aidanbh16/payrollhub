import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { POST as idpLoginPOST } from "@/app/mock-idp/[tenantId]/login/route";
import { deleteDatabase, migrateDatabase } from "@/data/db/migrate";
import { SEED_TENANTS, seedDatabase, seededIdpPassword } from "@/scripts/lib/seed";
import { setupSeededDatabase } from "../helpers/database";
import { Browser } from "../helpers/http";

// RT-02 (Turn 13 red team): every install seeded the same employee IdP passwords, published in the README, and
// `next start` listened on all interfaces, so a classmate on the same network could sign in to another classmate's
// install as any employee. Now the passwords are random per install (only in the gitignored credentials file) and the
// app and the stand-in bank listen on 127.0.0.1 by default.

setupSeededDatabase();

const ROOT = join(__dirname, "..", "..");
const read = (file: string) => readFileSync(join(ROOT, file), "utf8");
const employees = SEED_TENANTS.flatMap((t) => t.employees.map((e) => ({ tenantId: t.tenantId, email: e.email })));

/** Signs in at the stand-in IdP; true when it issued an assertion (the page then auto-posts it to PayrollHub). */
async function idpSignIn(tenantId: string, email: string, password: string): Promise<boolean> {
  const res = await new Browser().post(idpLoginPOST, `/mock-idp/${tenantId}/login`, { email, password }, { tenantId });
  return res.status === 200 && (await res.text()).includes('name="assertion"');
}

describe("[L1-20 DiD] seeded employee IdP passwords are per install (RT-02)", () => {
  it("the Turn 13 reproduction: the documented password no longer signs anyone in at the stand-in IdP", async () => {
    expect(await idpSignIn("acme", "alice@acme.test", "Acme-Employee-Dev-2026!")).toBe(false);
    expect(await idpSignIn("globex", "dana@globex.test", "Globex-Employee-Dev-2026!")).toBe(false);
    // The install's own password (from its credentials file) still works.
    expect(await idpSignIn("acme", "alice@acme.test", seededIdpPassword("alice@acme.test"))).toBe(true);
  });

  it("a new seed writes new random passwords, and none is in the seed source or the README", async () => {
    const before = employees.map((e) => seededIdpPassword(e.email));
    for (const password of before) expect(password).toMatch(/^[A-Za-z0-9_-]{24}$/); // 144 bits
    expect(new Set(before).size).toBe(employees.length);
    deleteDatabase();
    migrateDatabase();
    await seedDatabase();
    const after = employees.map((e) => seededIdpPassword(e.email));
    after.forEach((password, i) => expect(password).not.toBe(before[i]));
    expect(await idpSignIn("acme", "alice@acme.test", before[0])).toBe(false);
    for (const file of ["scripts/lib/seed.ts", "README.md"]) {
      expect(read(file)).not.toMatch(/Employee-Dev-\d{4}!/);
      for (const password of [...before, ...after]) expect(read(file)).not.toContain(password);
    }
  });
});

describe("[L1-20 DiD] servers listen on 127.0.0.1 by default (RT-02)", () => {
  it("npm run dev and npm run start bind the app to 127.0.0.1", () => {
    const scripts = JSON.parse(read("package.json")).scripts as Record<string, string>;
    expect(scripts.dev).toMatch(/^next dev -H 127\.0\.0\.1\b/);
    expect(scripts.start).toMatch(/^next start -H 127\.0\.0\.1\b/);
  });

  it("the stand-in bank binds to 127.0.0.1", () => {
    expect(read("scripts/mock-bank.ts")).toMatch(/host: "127\.0\.0\.1"/);
  });
});
