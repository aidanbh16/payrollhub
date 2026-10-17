import { NextResponse } from "next/server";
import { route } from "@/application/http/route";
import { createRunBody } from "@/application/validation/runs";
import { createDraftRun, listRuns } from "@/services/engine/engine-service";
import { mintAsBff } from "@/application/mint-as-bff";

// HR Admin creates a draft payroll run (L2-04). The tenant is the session's; a different [tenantId] in the path is
// refused by the wrapper, and the body schema is strict, so a tenantId in the body is rejected too.
// The call to Payroll Engine carries a scoped service token minted for exactly this endpoint and tenant (L1-19).
export const POST = route.session({
  roles: ["hr_admin"],
  tenantInPath: true,
  body: { type: "json", schema: createRunBody },
  handler: async ({ session, tenantId, body }) => {
    const token = await mintAsBff("engine.createRun", tenantId);
    const run = await createDraftRun(token, { tenantId, payDate: body.payDate, createdBy: session.userId });
    return NextResponse.json(run, { status: 201 });
  },
});

// The tenant's payroll runs, with status and the D29 late flag, for the HR Admin and approver consoles.
export const GET = route.session({
  roles: ["hr_admin", "approver"],
  tenantInPath: true,
  handler: async ({ tenantId }) => ({ runs: await listRuns(await mintAsBff("engine.listRuns", tenantId), { tenantId }) }),
});
