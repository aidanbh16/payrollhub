import { NextResponse } from "next/server";
import { DEVICE_COOKIE } from "@/application/auth/cookie-names";
import { setSessionCookie } from "@/application/auth/session-cookies";
import { HttpError, errorResponse, route } from "@/application/http/route";
import { mintAsBff } from "@/application/mint-as-bff";
import { approveRunBody, runParams } from "@/application/validation/runs";
import { issueApprovalToken } from "@/services/approval/approval-service";
import { TTL } from "@/services/identity/sessions";
import { stepUp } from "@/services/identity/step-up";

// A Payroll Approver approves a draft run (L2-01, L2-18; Assignment 5, Sections 2.1 and 2.4).
// 1. Fresh MFA step-up (Layer 2 stepUp()): no correct, unused TOTP code, no token. This also rotates the session id.
// 2. Payroll Approval issues a signed, single-use, 5-minute approval token bound to this tenant, run, and approver.
// The token goes back in the JSON body only: never in a cookie, and the client keeps it in memory only.
// Proxy throttles this route per session (code guessing) and fails closed if Redis is down (money route, D20).
export const POST = route.session({
  roles: ["approver"],
  tenantInPath: true,
  params: runParams,
  body: { type: "json", schema: approveRunBody },
  handler: async ({ request, requestId, session, tenantId, params, body }) => {
    const stepped = stepUp(session, { code: body.code, deviceId: request.cookies.get(DEVICE_COOKIE)?.value });
    if (!stepped) throw new HttpError(403, "Step-up verification failed");
    // The old session id is now revoked, so every response from here on must carry the new one.
    let res: NextResponse;
    try {
      const token = await mintAsBff("approval.issueToken", tenantId);
      const issued = await issueApprovalToken(token, { tenantId, runId: params.runId, approverId: session.userId }, stepped.proof);
      res = NextResponse.json(
        { runId: issued.runId, approvalToken: issued.approvalToken, expiresAt: issued.expiresAt },
        { headers: { "Cache-Control": "no-store" } },
      );
    } catch (err) {
      res = errorResponse(err, requestId);
    }
    setSessionCookie(res, stepped.cookie, TTL.privileged);
    return res;
  },
});
