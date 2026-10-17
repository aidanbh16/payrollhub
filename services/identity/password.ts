import "server-only";
import { randomBytes, scrypt, timingSafeEqual, type ScryptOptions } from "node:crypto";

// scrypt password hashing for HR Admin and Payroll Approver accounts (employees sign in through SSO).
// Parameters are one of the OWASP Password Storage Cheat Sheet's equivalent scrypt settings (N=2^15, r=8, p=3):
// about 32 MiB per hash, which resists GPU cracking without letting a login flood exhaust server memory.
// Stored format: scrypt$N$r$p$<salt base64>$<hash base64>, so parameters can be raised later without a migration.
const N = 2 ** 15;
const R = 8;
const P = 3;
const KEY_BYTES = 64;
const MAXMEM = 64 * 1024 * 1024;

function scryptAsync(password: string, salt: Buffer, length: number, options: ScryptOptions): Promise<Buffer> {
  return new Promise((resolve, reject) =>
    scrypt(password, salt, length, options, (err, key) => (err ? reject(err) : resolve(key))),
  );
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const hash = await scryptAsync(password, salt, KEY_BYTES, { N, r: R, p: P, maxmem: MAXMEM });
  return ["scrypt", N, R, P, salt.toString("base64"), hash.toString("base64")].join("$");
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [scheme, n, r, p, salt, hash] = stored.split("$");
  if (scheme !== "scrypt" || !salt || !hash) return false;
  const expected = Buffer.from(hash, "base64");
  const actual = await scryptAsync(password, Buffer.from(salt, "base64"), expected.length, {
    N: Number(n),
    r: Number(r),
    p: Number(p),
    maxmem: MAXMEM,
  });
  return timingSafeEqual(actual, expected);
}

let dummyHash: Promise<string> | undefined;

/**
 * A real hash of a random password. Login verifies against it when the tenant or user does not exist, so an unknown
 * account costs the same scrypt work as a wrong password and the response time does not reveal which one it was.
 */
export function dummyPasswordHash(): Promise<string> {
  dummyHash ??= hashPassword(randomBytes(32).toString("base64"));
  return dummyHash;
}
