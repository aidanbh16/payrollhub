import "server-only";
import { createPrivateKey, createPublicKey, generateKeyPairSync, sign, verify, type KeyObject } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { SignJWT, decodeProtectedHeader, jwtVerify, type JWTPayload } from "jose";
import { env } from "@/config/env";

// Local key store: the stand-in for the KMS in Assignment 5, Section 2.5 (DV-07). Every piece of key material
// PayrollHub uses comes from this module. Signing keys are versioned Ed25519 key pairs under KEYSTORE_DIR/<name>/
// v<N>.pem. Callers ask the store to sign or verify; no function returns a private key. Verification pins the
// algorithm (EdDSA) and accepts only the key version named in the token's kid header.
// Rotation (L2-18): rotateSigningKey() writes version N+1, then moves every older version to <name>/retired/. Only
// versions still in <name>/ verify, so every token signed with a retired key fails from that moment. The directory is
// re-listed on every call, so a rotation done by the CLI script (npm run keys:rotate) applies to a running server
// immediately, with no restart.
// The ACH batch key (L1-22) is different: it signs raw file bytes, not JWTs, and rotating it retires old versions for
// SIGNING only. Their private keys are deleted, but their public keys move to <name>/verify-only/ and keep verifying,
// so batches already signed and sent stay verifiable (audit, disputes, a resend of the same signed bytes). Approval and
// service tokens are short-lived bearer credentials, where rotation is the compromise response: every outstanding token
// must die at once. A batch signature is evidence attached to a stored record, so it must outlive the key's signing
// life. (If an ACH key is compromised, the bank must also stop trusting it: see README, "Rotating a signing key".)
// Limitation: keys sit on disk next to the app and are used in-process, with no hardware isolation.

export const SIGNING_KEYS = ["service-token", "approval-token", "ach-batch"] as const;
export type SigningKeyName = (typeof SIGNING_KEYS)[number];
/** Keys that sign JWTs. */
export type JwtKeyName = Exclude<SigningKeyName, "ach-batch">;
/** Keys that sign raw bytes. */
export type BytesKeyName = "ach-batch";

/** Keys whose old versions stay usable for verifying (never signing) after a rotation. */
const VERIFY_AFTER_ROTATION: ReadonlySet<SigningKeyName> = new Set(["ach-batch"]);

const ALGORITHM = "EdDSA";
const VERSION_FILE = /^v(\d+)\.pem$/;

interface KeyVersion {
  version: number;
  privateKey: KeyObject;
  publicKey: KeyObject;
}

// Parsed keys by file path, so re-listing the directory on each call does not re-read every PEM file.
const parsed = new Map<string, KeyVersion>();

function keyDir(name: SigningKeyName): string {
  return join(env().KEYSTORE_DIR, name);
}

function writeNewKey(dir: string, version: number): void {
  const { privateKey } = generateKeyPairSync("ed25519");
  writeFileSync(/*turbopackIgnore: true*/ join(dir, `v${version}.pem`), privateKey.export({ type: "pkcs8", format: "pem" }), { mode: 0o600 });
}

/** Creates version 1 of each signing key if it does not exist yet. Idempotent; run by db:reset and the tests. */
export function provisionSigningKeys(): void {
  for (const name of SIGNING_KEYS) {
    const dir = keyDir(name);
    mkdirSync(/*turbopackIgnore: true*/ dir, { recursive: true });
    if (readdirSync(/*turbopackIgnore: true*/ dir).some((f) => VERSION_FILE.test(f))) continue;
    writeNewKey(dir, 1);
  }
}

/** The active versions of a key, newest first. Re-listed on every call, so retired versions drop out at once. */
function versions(name: SigningKeyName): KeyVersion[] {
  const dir = keyDir(name);
  if (!existsSync(/*turbopackIgnore: true*/ dir)) throw new Error(`Signing key "${name}" is not provisioned. Run npm run db:reset.`);
  const found = readdirSync(/*turbopackIgnore: true*/ dir)
    .map((f) => VERSION_FILE.exec(f))
    .filter((m): m is RegExpExecArray => m !== null)
    .map((m) => {
      const path = join(dir, m[0]);
      let key = parsed.get(path);
      if (!key) {
        const privateKey = createPrivateKey(readFileSync(/*turbopackIgnore: true*/ path));
        key = { version: Number(m[1]), privateKey, publicKey: createPublicKey(privateKey) };
        parsed.set(path, key);
      }
      return key;
    })
    .sort((a, b) => b.version - a.version);
  if (found.length === 0) throw new Error(`Signing key "${name}" has no versions. Run npm run db:reset.`);
  return found;
}

/**
 * Rotates a signing key: creates the next version, then retires every older one.
 * - JWT keys: retired versions stop verifying immediately (the compromise response in Section 2.4).
 * - ach-batch: retired versions can no longer sign (their private keys are deleted), but their public keys keep
 *   verifying, so existing batches remain verifiable.
 */
export function rotateSigningKey(name: SigningKeyName): { version: number; retired: number[]; stillVerify: boolean } {
  const current = versions(name);
  const next = current[0].version + 1;
  const dir = keyDir(name);
  writeNewKey(dir, next);
  const keepForVerifying = VERIFY_AFTER_ROTATION.has(name);
  const target = join(dir, keepForVerifying ? "verify-only" : "retired");
  mkdirSync(/*turbopackIgnore: true*/ target, { recursive: true });
  for (const old of current) {
    const file = join(dir, `v${old.version}.pem`);
    if (keepForVerifying) {
      writeFileSync(/*turbopackIgnore: true*/ join(target, `v${old.version}.pub.pem`), old.publicKey.export({ type: "spki", format: "pem" }));
      unlinkSync(/*turbopackIgnore: true*/ file);
      parsed.delete(file);
    } else {
      renameSync(/*turbopackIgnore: true*/ file, join(target, `v${old.version}.pem`));
    }
  }
  return { version: next, retired: current.map((v) => v.version), stillVerify: keepForVerifying };
}

const VERIFY_ONLY_FILE = /^v(\d+)\.pub\.pem$/;

/** Public keys that verify for a key: the active versions plus, for ach-batch, versions kept for verification. */
function verificationKeys(name: SigningKeyName): { version: number; publicKey: KeyObject; canSign: boolean }[] {
  const keys = versions(name).map((v) => ({ version: v.version, publicKey: v.publicKey, canSign: true }));
  const dir = join(keyDir(name), "verify-only");
  if (VERIFY_AFTER_ROTATION.has(name) && existsSync(/*turbopackIgnore: true*/ dir)) {
    for (const f of readdirSync(/*turbopackIgnore: true*/ dir)) {
      const m = VERIFY_ONLY_FILE.exec(f);
      if (m) keys.push({ version: Number(m[1]), publicKey: createPublicKey(readFileSync(/*turbopackIgnore: true*/ join(dir, f))), canSign: false });
    }
  }
  return keys.sort((a, b) => b.version - a.version);
}

/**
 * Signs raw bytes (Ed25519) with the current version of a bytes key. The caller gets the signature and the version,
 * never the key. Used for ACH batch files (L1-22): the exact bytes that are sent are the bytes that are signed.
 */
export function signBytes(name: BytesKeyName, data: Buffer): { signature: Buffer; keyVersion: number } {
  const current = versions(name)[0];
  return { signature: sign(null, data, current.privateKey), keyVersion: current.version };
}

/** Verifies raw bytes against the named version, if that version still verifies (active or kept for verification). */
export function verifyBytes(name: BytesKeyName, data: Buffer, signature: Buffer, keyVersion: number): boolean {
  const key = verificationKeys(name).find((k) => k.version === keyVersion);
  return key !== undefined && verify(null, data, key.publicKey, signature);
}

/** The published public keys of a bytes key (for registering with the bank). Private keys never leave this module. */
export function publicSigningKeys(name: BytesKeyName): { version: number; publicKeyPem: string; canSign: boolean }[] {
  return verificationKeys(name).map((k) => ({ version: k.version, publicKeyPem: String(k.publicKey.export({ type: "spki", format: "pem" })), canSign: k.canSign }));
}

/** Versions that still verify. A token signed with any other version is dead. */
export function activeKeyVersions(name: SigningKeyName): number[] {
  return versions(name).map((v) => v.version);
}

const kid = (name: SigningKeyName, version: number) => `${name}:v${version}`;

/** Signs a JWT with the current version of the named key. iat and exp are set here; callers supply the claims. */
export async function signJwt(name: JwtKeyName, claims: JWTPayload, ttlSeconds: number): Promise<string> {
  return (await signJwtVersioned(name, claims, ttlSeconds)).token;
}

/** Like signJwt, but also reports which key version signed, for records that store it (ApprovalToken.key_version). */
export async function signJwtVersioned(
  name: JwtKeyName,
  claims: JWTPayload,
  ttlSeconds: number,
): Promise<{ token: string; keyVersion: number; issuedAt: Date; expiresAt: Date }> {
  const current = versions(name)[0];
  const now = Math.floor(Date.now() / 1000);
  const token = await new SignJWT(claims)
    .setProtectedHeader({ alg: ALGORITHM, kid: kid(name, current.version), typ: "JWT" })
    .setIssuedAt(now)
    .setExpirationTime(now + ttlSeconds)
    .sign(current.privateKey);
  return { token, keyVersion: current.version, issuedAt: new Date(now * 1000), expiresAt: new Date((now + ttlSeconds) * 1000) };
}

/** Verifies a JWT signed by the named key: pinned algorithm, an active key version, issuer, audience, and expiry. */
export async function verifyJwt(
  name: JwtKeyName,
  token: string,
  options: { issuer: string; audience: string; maxTokenAgeSeconds: number },
): Promise<JWTPayload & { keyVersion: number }> {
  const header = decodeProtectedHeader(token);
  const key = versions(name).find((v) => kid(name, v.version) === header.kid);
  if (!key) throw new Error("Unknown or retired signing key version");
  const { payload } = await jwtVerify(token, key.publicKey, {
    algorithms: [ALGORITHM],
    issuer: options.issuer,
    audience: options.audience,
    maxTokenAge: options.maxTokenAgeSeconds,
    requiredClaims: ["iat", "exp", "jti", "sub"],
  });
  return { ...payload, keyVersion: key.version };
}

let fieldKey: Buffer | undefined;

/**
 * The AES-256-GCM key for encryption at rest. It comes from FIELD_ENCRYPTION_KEY in .env (validated as 32 bytes by
 * config/env.ts) and is read once into memory. Documented limitation: a real deployment would fetch a data key from KMS.
 */
export function fieldEncryptionKey(): Buffer {
  fieldKey ??= Buffer.from(env().FIELD_ENCRYPTION_KEY, "base64");
  return fieldKey;
}
