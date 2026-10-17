import { NextResponse } from "next/server";
import { env } from "@/config/env";
import { HttpError, route } from "@/application/http/route";
import { mintAsBff } from "@/application/mint-as-bff";
import { disburseBody, runParams } from "@/application/validation/runs";

// The approver's "Send to bank" action (Assignment 5, Figure 6; who triggers it is D33). The BFF mints a single-use
// service token for ach.disburse and calls ACH Disbursement at /api/internal/ach over HTTP, at the configured loopback
// INTERNAL_API_ORIGIN. The request carries nothing but the run in the path. Proxy treats this as a money route (D20).
export const POST = route.session({
  roles: ["approver"],
  tenantInPath: true,
  params: runParams,
  body: { type: "json", schema: disburseBody },
  handler: async ({ tenantId, params }) => {
    const serviceToken = await mintAsBff("ach.disburse", tenantId);
    const target = new URL(`/api/internal/ach/tenants/${encodeURIComponent(tenantId)}/runs/${encodeURIComponent(params.runId)}/disburse`, env().INTERNAL_API_ORIGIN);
    let ach: Response;
    try {
      ach = await fetch(target, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${serviceToken}` },
        body: "{}",
        cache: "no-store",
      });
    } catch {
      throw new HttpError(502, "ACH service unavailable");
    }
    return new NextResponse(await ach.text(), {
      status: ach.status,
      headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
    });
  },
});
