import "server-only";
import type { NextRequest, NextResponse } from "next/server";
import { isWellFormedToken, randomToken } from "@/services/identity/sessions";
import { KNOWN_DEVICE_COOKIE } from "@/edge/known-devices";
import { UNLOCK_COOKIE, UNLOCK_GRANT_MS } from "@/edge/unlock";
import { DEVICE_COOKIE, SESSION_COOKIE } from "./cookie-names";

// Session and device cookies: Secure, HttpOnly (no script access), SameSite=Strict (not sent on cross-site requests).
const BASE = { httpOnly: true, secure: true, sameSite: "strict", path: "/" } as const;
const DEVICE_MAX_AGE_SECONDS = 365 * 24 * 60 * 60;

export function setSessionCookie(res: NextResponse, value: string, ttlMs: number): void {
  res.cookies.set(SESSION_COOKIE, value, { ...BASE, maxAge: Math.floor(ttlMs / 1000) });
}

/** D25: marks this browser as a known device for the account it just completed MFA for (stored hashed in Redis). */
export function setKnownDeviceCookie(res: NextResponse, token: string, maxAgeMs: number): void {
  res.cookies.set(KNOWN_DEVICE_COOKIE, token, { ...BASE, maxAge: Math.floor(maxAgeMs / 1000) });
}

/** RT-04 (D46): this browser opened an unlock link; Proxy gives it a fresh sign-in budget for that account. */
export function setUnlockCookie(res: NextResponse, token: string): void {
  res.cookies.set(UNLOCK_COOKIE, token, { ...BASE, maxAge: Math.floor(UNLOCK_GRANT_MS / 1000) });
}

export function clearSessionCookie(res: NextResponse): void {
  res.cookies.set(SESSION_COOKIE, "", { ...BASE, maxAge: 0 });
}

/**
 * Returns this browser's device id, creating the device cookie if it is missing. Sessions are bound to the hash of
 * this id (Section 2.1), so a session cookie replayed from another browser without it is rejected.
 */
export function ensureDeviceId(request: NextRequest, res: NextResponse): string {
  const existing = request.cookies.get(DEVICE_COOKIE)?.value;
  if (isWellFormedToken(existing)) return existing;
  const deviceId = randomToken();
  res.cookies.set(DEVICE_COOKIE, deviceId, { ...BASE, maxAge: DEVICE_MAX_AGE_SECONDS });
  return deviceId;
}
