import { route } from "@/application/http/route";
import { runParams } from "@/application/validation/runs";
import { getBatchStatus } from "@/services/ach/ach-service";

// Internal (D6): ACH Disbursement's batch status for a run. Accepts only a scoped service token for ach.getBatch,
// minted for the tenant in the path. Returns metadata only, never the file body.
export const GET = route.service({
  endpoint: "ach.getBatch",
  tenantInPath: true,
  params: runParams,
  handler: async ({ service, tenantId, params }) => ({ ...(await getBatchStatus(service, { tenantId, runId: params.runId })) }),
});
