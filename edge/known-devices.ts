import { createHash } from "node:crypto";
import { edgeRedis } from "./rate-limiter";

// Known devices (D25). After a successful MFA step, the browser gets a random known-device cookie, and its SHA-256 is
// added to that account's set in Redis. Later sign-ins to the same account from that browser use their own budget and
// skip the login-class ceiling, so an attacker who spends an account's unknown-device attempts, or floods the login
// route, cannot lock the real admin out of a device they have already used. The cookie is useless for any other
// account, and Redis never holds the cookie value, only its hash.

export const KNOWN_DEVICE_COOKIE = "__Host-ph_known";
export const KNOWN_DEVICE_TTL_MS = 90 * 24 * 60 * 60 * 1000;

const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");
const TOKEN = /^[A-Za-z0-9_-]{43}$/;

const setKey = (prefix: string, account: string) => `${prefix}:known:${account}`;
// Every known device across accounts, for the MFA step, where Proxy only has the pending session cookie and so cannot
// tell which account the attempt is for. It still needs an unforgeable cookie that completed MFA somewhere.
const anyKey = (prefix: string) => `${prefix}:known-any`;

/** The account a sign-in targets: tenant + email, trimmed and lowercased, hashed. Shared by Proxy and the MFA step. */
export function accountHash(tenant: unknown, email: unknown): string {
  const norm = (v: unknown) => (typeof v === "string" ? v.trim().toLowerCase() : "");
  return sha256(`${norm(tenant)}\n${norm(email)}`);
}

export const deviceHash = (token: string) => sha256(token);

export async function isKnownDevice(account: string, token: string | undefined): Promise<boolean> {
  if (!token || !TOKEN.test(token)) return false;
  return edgeRedis(async (redis, prefix) => (await redis.sIsMember(setKey(prefix, account), deviceHash(token))) === 1);
}

/** True if this browser completed MFA for any account (MFA step only; step 1 uses the account-bound check). */
export async function isKnownDeviceForAnyAccount(token: string | undefined): Promise<boolean> {
  if (!token || !TOKEN.test(token)) return false;
  return edgeRedis(async (redis, prefix) => (await redis.sIsMember(anyKey(prefix), deviceHash(token))) === 1);
}

/** Records this browser as known for the account. Called only after a successful MFA step. */
export async function rememberKnownDevice(account: string, token: string): Promise<void> {
  await edgeRedis(async (redis, prefix) => {
    for (const key of [setKey(prefix, account), anyKey(prefix)]) {
      await redis.sAdd(key, deviceHash(token));
      await redis.pExpire(key, KNOWN_DEVICE_TTL_MS);
    }
  });
}
