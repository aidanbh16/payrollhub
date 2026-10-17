import { route } from "@/application/http/route";
import { runParams, startRunBody } from "@/application/validation/runs";
import { startRun } from "@/services/engine/engine-service";

// Internal (D6): the only way to reach Payroll Engine's run computation. Accepts only a single-use service token for
// engine.startRun, minted for the tenant in the path. The body carries the approval token and nothing else; every
// amount, employee, and account comes from the database (L2-02; Assignment 5, Figure 6).
export const POST = route.service({
  endpoint: "engine.startRun",
  tenantInPath: true,
  params: runParams,
  body: { type: "json", schema: startRunBody },
  handler: async ({ service, tenantId, params, body }) => ({
    ...(await startRun(service, { tenantId, runId: params.runId, approvalToken: body.approvalToken })),
  }),
});
