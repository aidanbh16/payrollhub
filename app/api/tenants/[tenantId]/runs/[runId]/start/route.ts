import { decodeJwt } from "jose";
import { NextResponse } from "next/server";
import { env } from "@/config/env";
import { HttpError, route } from "@/application/http/route";
import { mintAsBff } from "@/application/mint-as-bff";
import { runParams, startRunBody } from "@/application/validation/runs";

// The approver's "Run payroll" action (Assignment 5, Figure 6). The browser sends only the approval token it holds in
// memory. The BFF mints a single-use service token for engine.startRun and calls Payroll Engine at
// /api/internal/engine over HTTP, at the configured INTERNAL_API_ORIGIN (never an origin taken from this request, so a
// forged Host header cannot send the tokens elsewhere). Proxy treats this as a money route (fails closed, D20).
export const POST = route.session({
  roles: ["approver"],
  tenantInPath: true,
  params: runParams,
  body: { type: "json", schema: startRunBody },
  handler: async ({ session, tenantId, params, body }) => {
    // Only the approver the token was issued to may present it. Payroll Engine verifies the signature itself.
    let subject: unknown;
    try {
      subject = decodeJwt(body.approvalToken).sub;
    } catch {
      subject = undefined;
    }
    if (subject !== session.userId) throw new HttpError(403, "Approval token rejected");

    const serviceToken = await mintAsBff("engine.startRun", tenantId);
    const target = new URL(`/api/internal/engine/tenants/${encodeURIComponent(tenantId)}/runs/${encodeURIComponent(params.runId)}/start`, env().INTERNAL_API_ORIGIN);
    let engine: Response;
    try {
      engine = await fetch(target, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${serviceToken}` },
        body: JSON.stringify({ approvalToken: body.approvalToken }),
        cache: "no-store",
      });
    } catch {
      throw new HttpError(502, "Payroll engine unavailable");
    }
    return new NextResponse(await engine.text(), {
      status: engine.status,
      headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
    });
  },
});
