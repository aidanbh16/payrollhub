import { route } from "@/application/http/route";
import { mintAsBff } from "@/application/mint-as-bff";
import { listPayStatements } from "@/services/engine/engine-service";

// The signed-in employee's own pay statements. The employee comes from the session, never from the request.
export const GET = route.session({
  roles: ["employee"],
  tenantInPath: true,
  handler: async ({ session, tenantId }) => ({
    statements: await listPayStatements(await mintAsBff("engine.payStatements", tenantId), { tenantId, employeeUserId: session.userId }),
  }),
});
