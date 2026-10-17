import type { NextResponse } from "next/server";

// Browser-level security headers (Layer 9; Assignment 5, Section 2.1). Proxy calls these for every response it lets
// through or creates. next.config.ts adds the static ones (nosniff, no framing, no Referer) to every response as well,
// including build assets.
//
// Content-Security-Policy: inline scripts only with this request's nonce, script files only from this origin (Next.js's
// own chunks); no 'unsafe-inline', and no 'unsafe-eval' outside `next dev` (React needs eval there for error overlays).
// No 'strict-dynamic' (unlike the Next.js guide's example): it would let any script that is already running insert
// further inline scripts, and Next.js does not need it, since its chunks are same-origin files.
// Everything else from this origin only: no third-party scripts, styles, images, fonts, or connections, no plugins, no
// <base> rewriting, forms post only to this origin, and the app cannot be framed. Nonces require every page to be
// rendered per request, which is why Cache Components is off (DV-44).

export const NONCE_HEADER = "x-nonce";

/** 128 random bits, base64: a fresh nonce for one request. */
export function newNonce(): string {
  return Buffer.from(crypto.getRandomValues(new Uint8Array(16))).toString("base64");
}

export function contentSecurityPolicy(nonce: string, dev = process.env.NODE_ENV === "development"): string {
  return [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}'${dev ? " 'unsafe-eval'" : ""}`,
    // In development, Next.js injects styles at runtime without a nonce; production uses stylesheets and nonces only.
    `style-src 'self' ${dev ? "'unsafe-inline'" : `'nonce-${nonce}'`}`,
    "img-src 'self' data:",
    "font-src 'self'",
    "connect-src 'self'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join("; ");
}

/**
 * Headers for a response: the CSP, and no-store so nothing is kept in the browser's or any shared cache. Every page
 * that is not a build asset either shows session data or is a sign-in form, so none of them may be cached; this is
 * what makes the back button after sign-out show nothing sensitive.
 */
export function applySecurityHeaders(response: NextResponse, nonce: string): NextResponse {
  response.headers.set("Content-Security-Policy", contentSecurityPolicy(nonce));
  response.headers.set("Cache-Control", "no-store");
  return response;
}
