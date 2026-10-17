import { createHash } from "node:crypto";
import { edgeRedis } from "./rate-limiter";

// Unlock links (RT-04, D46). A staff member locked out of sign-in on a new device (D25's unknown-device backoff, which
// anyone who knows their organization and email can trigger) asks for an unlock link; it goes only to their own
// mailbox. Opening it gives THE BROWSER THAT OPENS IT a fresh sign-in budget for that account: an unlock cookie whose
// hash is added to the account's unlocked set. It restores a budget and nothing else: the password and the TOTP code
// are still required. Redis keeps only hashes: the link token's SHA-256 (single-use: read and deleted in one GETDEL,
// expiring after UNLOCK_TTL_MS) and the unlock cookie's SHA-256.

export const UNLOCK_COOKIE = "__Host-ph_unlock";
/** How long an unlock link works. */
export const UNLOCK_TTL_MS = 15 * 60 * 1000;
/** How long the fresh budget lasts on the browser that opened the link. */
export const UNLOCK_GRANT_MS = 15 * 60 * 1000;

const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");
const TOKEN = /^[A-Za-z0-9_-]{43}$/;
const tokenKey = (prefix: string, token: string) => `${prefix}:unlock-token:${sha256(token)}`;
const grantKey = (prefix: string, account: string) => `${prefix}:unlocked:${account}`;

/** Records a new link token (hashed) for an account. Called for every request, real account or not (D46). */
export async function storeUnlockToken(account: string, token: string): Promise<void> {
  await edgeRedis((redis, prefix) => redis.set(tokenKey(prefix, token), account, { PX: UNLOCK_TTL_MS }));
}

/** Uses a link token once: returns its account, or null if it is unknown, expired, or already used. */
export async function consumeUnlockToken(token: string): Promise<string | null> {
  if (!TOKEN.test(token)) return null;
  return edgeRedis((redis, prefix) => redis.getDel(tokenKey(prefix, token)));
}

/** Gives the browser holding `cookie` a fresh sign-in budget for the account (Proxy checks isUnlockedDevice). */
export async function grantUnlockedDevice(account: string, cookie: string): Promise<void> {
  await edgeRedis(async (redis, prefix) => {
    await redis.sAdd(grantKey(prefix, account), sha256(cookie));
    await redis.pExpire(grantKey(prefix, account), UNLOCK_GRANT_MS);
  });
}

export async function isUnlockedDevice(account: string, cookie: string | undefined): Promise<boolean> {
  if (!cookie || !TOKEN.test(cookie)) return false;
  return edgeRedis(async (redis, prefix) => (await redis.sIsMember(grantKey(prefix, account), sha256(cookie))) === 1);
}

export const unlockedDeviceHash = (cookie: string) => sha256(cookie);
