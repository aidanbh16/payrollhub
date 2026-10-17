import type { NextRequest } from "next/server";
import { env } from "@/config/env";

// Next.js 16 gives Proxy no client address a client cannot forge: there is no request.ip, and Next.js copies the
// socket address into X-Forwarded-For only when the client did not send that header itself (`??=` in the server), so
// any client can put any value there. PayrollHub therefore never reads X-Forwarded-For.
//
// Per-IP limits run only when a deployment puts a reverse proxy in front of the app that overwrites one header with
// the real client address, and names that header in TRUSTED_CLIENT_IP_HEADER. Without it, the per-account and
// per-class limits carry the load (documented deviation from Section 2.2's per-IP throttle).

export function trustedClientIp(request: NextRequest): string | null {
  const header = env().TRUSTED_CLIENT_IP_HEADER;
  if (!header) return null;
  const value = request.headers.get(header)?.trim();
  // One address only: a comma means a client-appended list reached us unfiltered, which a trusted proxy never sends.
  if (!value || value.includes(",") || value.length > 45) return null;
  return value;
}
