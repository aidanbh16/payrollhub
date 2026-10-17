import { execFileSync } from "node:child_process";
import { X509Certificate } from "node:crypto";
import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { parseEnv } from "@/config/env";

// RT-05 (Turn 13 red team): every install's Redis used the password printed in .env.example and the README, so anyone
// who read the README could connect to a Redis they could reach and plant known devices, inflate another account's
// backoff (lock an admin out), or clear counters (L1-05, D25). Now npm run setup generates a random password into .env,
// docker compose reads it from there, and the app refuses to start with the documented placeholder.
// RT-08 (accepted) is confirmed here too: each install gets its own field-encryption key and local CA.

const ROOT = join(__dirname, "..", "..");
const PLACEHOLDER = "dev-only-redis-password-change-me";
const base = { ...process.env };
const temps: string[] = [];
afterAll(() => temps.forEach((dir) => rmSync(dir, { recursive: true, force: true })));

/** A fresh checkout's npm run setup, in its own folder: returns the .env it wrote and its CA certificate. */
function freshInstall(existingEnv?: string) {
  const dir = mkdtempSync(join(tmpdir(), "payrollhub-setup-"));
  temps.push(dir);
  copyFileSync(join(ROOT, ".env.example"), join(dir, ".env.example"));
  if (existingEnv !== undefined) writeFileSync(join(dir, ".env"), existingEnv);
  execFileSync(process.execPath, [join(ROOT, "node_modules", "tsx", "dist", "cli.mjs"), join(ROOT, "scripts", "setup.ts")], { cwd: dir, stdio: "pipe" });
  const env = Object.fromEntries(
    readFileSync(join(dir, ".env"), "utf8")
      .split(/\r?\n/)
      .filter((l) => /^[A-Z_]+=/.test(l))
      .map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]),
  );
  const ca = new X509Certificate(readFileSync(join(dir, ".data", "pki", "ca.pem")));
  return { env, caFingerprint: ca.fingerprint256 };
}

describe("[L1-05 DiD] the Redis password is generated per install (RT-05)", () => {
  it("the Turn 13 reproduction: the app refuses to start with the documented placeholder password", () => {
    for (const url of [`redis://:${PLACEHOLDER}@127.0.0.1:6379`, `redis://default:${PLACEHOLDER}@localhost:6379/0`]) {
      expect(() => parseEnv({ ...base, REDIS_URL: url })).toThrow(/REDIS_URL/);
      expect(() => parseEnv({ ...base, REDIS_URL: url })).not.toThrow(new RegExp(PLACEHOLDER));
    }
    expect(parseEnv({ ...base, REDIS_URL: "redis://:a-generated-password@127.0.0.1:6379" }).REDIS_URL).toContain("a-generated-password");
  });

  it("neither .env.example nor the README nor docker-compose.yml carries a usable password", () => {
    for (const file of [".env.example", "README.md", "docker-compose.yml"]) expect(readFileSync(join(ROOT, file), "utf8")).not.toContain(PLACEHOLDER);
    expect(readFileSync(join(ROOT, "docker-compose.yml"), "utf8")).toMatch(/--requirepass\s+- \$\{REDIS_PASSWORD:\?/);
  });

  it("npm run setup writes a random Redis password and a matching REDIS_URL, different for every install", () => {
    const a = freshInstall();
    const b = freshInstall();
    for (const { env } of [a, b]) {
      expect(env.REDIS_PASSWORD).toMatch(/^[A-Za-z0-9_-]{32,}$/);
      expect(env.REDIS_URL).toBe(`redis://:${env.REDIS_PASSWORD}@127.0.0.1:6379`);
      expect(() => parseEnv({ ...base, ...env })).not.toThrow();
    }
    expect(a.env.REDIS_PASSWORD).not.toBe(b.env.REDIS_PASSWORD);
    // RT-08: the field-encryption key and the local CA are per install too.
    expect(a.env.FIELD_ENCRYPTION_KEY).not.toBe(b.env.FIELD_ENCRYPTION_KEY);
    expect(a.caFingerprint).not.toBe(b.caFingerprint);
  });

  it("an existing .env that still has the placeholder gets a new password; one with a real password is kept", () => {
    const old = `REDIS_PASSWORD=${PLACEHOLDER}\nREDIS_URL=redis://:${PLACEHOLDER}@127.0.0.1:6379\n`;
    const replaced = freshInstall(old).env;
    expect(replaced.REDIS_PASSWORD).not.toBe(PLACEHOLDER);
    expect(replaced.REDIS_URL).toBe(`redis://:${replaced.REDIS_PASSWORD}@127.0.0.1:6379`);
    const kept = freshInstall("REDIS_PASSWORD=mine-already\nREDIS_URL=redis://:mine-already@127.0.0.1:6379\n").env;
    expect(kept.REDIS_PASSWORD).toBe("mine-already");
    expect(kept.REDIS_URL).toBe("redis://:mine-already@127.0.0.1:6379");
  });
});
