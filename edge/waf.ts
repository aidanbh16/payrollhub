import { NextResponse, type NextRequest } from "next/server";
import type { Policy } from "./route-policy";

// WAF-style request filtering (D8; Assignment 5, Section 2.2). Runs first in Proxy and looks only at the request line
// and headers, so a request it rejects never has its body read by PayrollHub. Malformed and oversized requests are
// turned away before any rate-limit, auth, or application code runs.

const MAX_URL_LENGTH = 2048;
// Path checks see the URL after the WHATWG URL parser has run (Next.js parses it before Proxy). Dot segments ("..",
// ".", "%2e%2e", "%2e") are resolved by the URL parser before Proxy runs, so Proxy and the router always see the same
// path and a dot segment cannot skip a check (RT-09); the parser also turns "\" into "/" and percent-encodes raw
// control characters. What can still arrive, and is refused here, is the encoded form of things no PayrollHub URL
// contains: an encoded dot left inside a segment, an encoded slash or backslash, and encoded control characters (NUL
// included).
const SUSPICIOUS_PATH = /%2e|%2f|%5c|%[01][0-9a-f]|%7f/i;
const BODY_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);
const ALLOWED_CONTENT_TYPES = ["application/x-www-form-urlencoded", "application/json"];

const reject = (status: number, error: string, headers: Record<string, string> = {}) =>
  NextResponse.json({ error }, { status, headers: { "Cache-Control": "no-store", ...headers } });

export function inspectRequest(request: NextRequest, policy: Policy): NextResponse | null {
  const url = request.url;
  if (url.length > MAX_URL_LENGTH) return reject(414, "URI too long");
  const rawPath = url.slice(url.indexOf("/", url.indexOf("//") + 2)).split("?")[0];
  if (SUSPICIOUS_PATH.test(rawPath)) return reject(400, "Malformed request");

  if (!policy.methods.includes(request.method)) return reject(405, "Method not allowed", { Allow: policy.methods.join(", ") });

  const length = request.headers.get("content-length");
  // Transfer-Encoding alongside a body length is a request-smuggling pattern; a chunked body has no length to check.
  if (request.headers.has("transfer-encoding")) return reject(411, "A Content-Length body is required");

  if (!BODY_METHODS.has(request.method)) {
    if (length !== null && length !== "0") return reject(400, "Malformed request");
    return null;
  }
  if (length === null || !/^\d{1,9}$/.test(length)) return reject(411, "A Content-Length body is required");
  if (Number(length) > policy.maxBodyBytes) return reject(413, "Request body too large");
  const type = (request.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();
  if (Number(length) > 0 && !ALLOWED_CONTENT_TYPES.includes(type)) return reject(415, "Unsupported content type");
  return null;
}
