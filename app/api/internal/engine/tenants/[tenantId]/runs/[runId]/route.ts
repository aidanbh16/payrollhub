import { route } from "@/application/http/route";
import { runParams } from "@/application/validation/runs";
import { getRun } from "@/services/engine/engine-service";

// Internal (D6): Payroll Engine's run lookup for other services. Accepts only a scoped service token for
// engine.getRun, minted for the tenant in the path; session cookies are ignored.
export const GET = route.service({
  endpoint: "engine.getRun",
  tenantInPath: true,
  params: runParams,
  handler: async ({ service, tenantId, params }) => ({ ...(await getRun(service, { tenantId, runId: params.runId })) }),
});
