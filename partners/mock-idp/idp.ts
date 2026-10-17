import "server-only";
import { createPrivateKey, generateKeyPairSync, randomBytes, randomUUID, scrypt, timingSafeEqual } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { SignJWT } from "jose";
import { env } from "@/config/env";

// Stand-in for each tenant's enterprise SSO identity provider (D11). It plays the external party in Assignment 5,
// Section 2.5: it has its own signing key and its own employee directory, kept under MOCK_IDP_DIR, and shares
// nothing with PayrollHub except the public key registered in TenantIdpConfig. It deliberately does not import any
// PayrollHub service or database code.

export const ASSERTION_ALGORITHM = "ES256";
const ASSERTION_LIFETIME_SECONDS = 120;
const TENANT_ID = /^[a-z][a-z0-9-]{1,39}$/;

interface DirectoryUser {
  email: string;
  subject: string;
  passwordHash: string;
}

interface Directory {
  tenantId: string;
  issuer: string;
  audience: string;
  users: DirectoryUser[];
}

export const idpIssuer = (tenantId: string) => `urn:payrollhub:mock-idp:${tenantId}`;
export const idpAudience = (tenantId: string) => `urn:payrollhub:sp:${tenantId}`;

function paths(tenantId: string) {
  // The tenant id is used in a file path, so it must match the strict slug format (no "../").
  if (!TENANT_ID.test(tenantId)) throw new Error("Invalid tenant id");
  const dir = env().MOCK_IDP_DIR;
  return { dir, directory: join(dir, `${tenantId}.directory.json`), key: join(dir, `${tenantId}.key.pem`) };
}

function scryptHash(password: string, salt: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => scrypt(password, salt, 32, (err, key) => (err ? reject(err) : resolve(key))));
}

async function hashIdpPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  return `${salt.toString("base64")}$${(await scryptHash(password, salt)).toString("base64")}`;
}

async function checkIdpPassword(password: string, stored: string): Promise<boolean> {
  const [salt, hash] = stored.split("$");
  const actual = await scryptHash(password, Buffer.from(salt, "base64"));
  const expected = Buffer.from(hash, "base64");
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

/**
 * Seeds one tenant's IdP: a new P-256 signing key pair and the employee directory. Returns what PayrollHub must
 * register in TenantIdpConfig. The private key never leaves MOCK_IDP_DIR.
 */
export async function provisionTenantIdp(
  tenantId: string,
  employees: { email: string; subject: string; password: string }[],
): Promise<{ issuer: string; audience: string; publicKeyPem: string }> {
  const p = paths(tenantId);
  const { publicKey, privateKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const directory: Directory = {
    tenantId,
    issuer: idpIssuer(tenantId),
    audience: idpAudience(tenantId),
    users: await Promise.all(
      employees.map(async (e) => ({ email: e.email, subject: e.subject, passwordHash: await hashIdpPassword(e.password) })),
    ),
  };
  mkdirSync(/*turbopackIgnore: true*/ p.dir, { recursive: true });
  writeFileSync(/*turbopackIgnore: true*/ p.key, privateKey.export({ type: "pkcs8", format: "pem" }), { mode: 0o600 });
  writeFileSync(/*turbopackIgnore: true*/ p.directory, JSON.stringify(directory, null, 2));
  return { issuer: directory.issuer, audience: directory.audience, publicKeyPem: publicKey.export({ type: "spki", format: "pem" }).toString() };
}

function loadDirectory(tenantId: string): Directory | null {
  try {
    return JSON.parse(readFileSync(/*turbopackIgnore: true*/ paths(tenantId).directory, "utf8")) as Directory;
  } catch {
    return null;
  }
}

let dummy: Promise<string> | undefined;

/** Checks an employee's IdP password. Unknown tenants and users cost the same scrypt work as a wrong password. */
export async function authenticateAtIdp(tenantId: string, email: string, password: string): Promise<string | null> {
  const user = TENANT_ID.test(tenantId) ? loadDirectory(tenantId)?.users.find((u) => u.email === email) : undefined;
  dummy ??= hashIdpPassword(randomBytes(16).toString("base64"));
  const ok = await checkIdpPassword(password, user?.passwordHash ?? (await dummy));
  return user && ok ? user.subject : null;
}

/** Issues a short-lived signed assertion for a subject this IdP has authenticated. */
export async function issueAssertion(tenantId: string, subject: string, now = new Date()): Promise<string> {
  const p = paths(tenantId);
  const key = createPrivateKey(readFileSync(/*turbopackIgnore: true*/ p.key));
  const iat = Math.floor(now.getTime() / 1000);
  return new SignJWT({ tid: tenantId })
    .setProtectedHeader({ alg: ASSERTION_ALGORITHM, typ: "JWT" })
    .setIssuer(idpIssuer(tenantId))
    .setAudience(idpAudience(tenantId))
    .setSubject(subject)
    .setIssuedAt(iat)
    .setExpirationTime(iat + ASSERTION_LIFETIME_SECONDS)
    .setJti(randomUUID())
    .sign(key);
}
