import { route } from "@/application/http/route";
import { mintAsBff } from "@/application/mint-as-bff";
import { runParams, updateRunBody } from "@/application/validation/runs";
import { getRun, updateRun } from "@/services/engine/engine-service";

// Reads one payroll run. A run id from another tenant gets exactly the same 404 as an id that does not exist.
export const GET = route.session({
  roles: ["hr_admin", "approver"],
  tenantInPath: true,
  params: runParams,
  handler: async ({ tenantId, params }) => {
    const token = await mintAsBff("engine.getRun", tenantId);
    return { ...(await getRun(token, { tenantId, runId: params.runId })) };
  },
});

// HR Admin edits a draft run's pay date. An approved run cannot be edited (409); the database enforces it too.
export const POST = route.session({
  roles: ["hr_admin"],
  tenantInPath: true,
  params: runParams,
  body: { type: "json", schema: updateRunBody },
  handler: async ({ tenantId, params, body }) => {
    const token = await mintAsBff("engine.updateRun", tenantId);
    return { ...(await updateRun(token, { tenantId, runId: params.runId, payDate: body.payDate })) };
  },
});
