import "server-only";
import { NextResponse, type NextRequest } from "next/server";

/**
 * Rejects cross-site form posts and fetches, before any credential or session is touched. SameSite=Strict cookies are
 * the second layer.
 *   1. An Origin header naming another origin is refused.
 *   2. Fetch Metadata: browsers send Sec-Fetch-Site on every request, and page scripts cannot set or change it. When it
 *      is present it must be "same-origin". This is what lets same-origin posts through even though PayrollHub sends
 *      Referrer-Policy: no-referrer, under which browsers send "Origin: null" for same-origin POSTs too.
 *   3. Without Fetch Metadata (a non-browser client, or a browser too old to send it), the check falls back to Origin,
 *      which must be present and name this origin exactly. A missing Origin and "Origin: null" (an opaque origin, such
 *      as a sandboxed frame, or an old browser under no-referrer) are refused: the request fails closed (D39).
 */
export function isSameOrigin(request: NextRequest): boolean {
  const origin = request.headers.get("origin");
  if (origin !== null && origin !== "null" && origin !== request.nextUrl.origin) return false;
  const site = request.headers.get("sec-fetch-site");
  if (site !== null) return site === "same-origin";
  return origin === request.nextUrl.origin;
}

/** 303 See Other: after a form POST, the browser follows with a GET. */
export function redirectTo(request: NextRequest, path: string): NextResponse {
  const res = NextResponse.redirect(new URL(path, request.url), 303);
  res.headers.set("Cache-Control", "no-store");
  return res;
}
