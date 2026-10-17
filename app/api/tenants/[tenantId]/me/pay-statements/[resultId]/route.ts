import { route } from "@/application/http/route";
import { mintAsBff } from "@/application/mint-as-bff";
import { statementParams } from "@/application/validation/runs";
import { getPayStatement } from "@/services/engine/engine-service";

// One of the signed-in employee's own pay statements. Another employee's result id gets the same 404 as one that does
// not exist: the lookup is bound to the session's employee, so changing the id in a URL reveals nothing.
export const GET = route.session({
  roles: ["employee"],
  tenantInPath: true,
  params: statementParams,
  handler: async ({ session, tenantId, params }) => ({
    ...(await getPayStatement(await mintAsBff("engine.payStatements", tenantId), { tenantId, employeeUserId: session.userId, resultId: params.resultId })),
  }),
});
