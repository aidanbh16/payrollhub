import { route } from "@/application/http/route";
import { disburseBody, runParams } from "@/application/validation/runs";
import { disburseRun } from "@/services/ach/ach-service";

// Internal (D6): ACH Disbursement builds, signs, and sends a computed run's batch. Accepts only a single-use service
// token for ach.disburse, minted for the tenant in the path. The body must be empty (strict): nothing about the batch
// comes from the request. Returns batch metadata only, never the file.
export const POST = route.service({
  endpoint: "ach.disburse",
  tenantInPath: true,
  params: runParams,
  body: { type: "json", schema: disburseBody },
  handler: async ({ service, tenantId, params }) => ({ ...(await disburseRun(service, { tenantId, runId: params.runId })) }),
});
