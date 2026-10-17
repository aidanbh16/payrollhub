import { route } from "@/application/http/route";
import { mintAsBff } from "@/application/mint-as-bff";
import { getBankSummary } from "@/services/bank-account/bank-account-service";

// The signed-in employee's own pay account and pending change (last 4 digits only). "me" is the session's user:
// nothing in the request selects whose account is shown.
export const GET = route.session({
  roles: ["employee"],
  tenantInPath: true,
  handler: async ({ session, tenantId }) => ({ ...(await getBankSummary(await mintAsBff("bankAccount.summary", tenantId), { tenantId, employeeUserId: session.userId })) }),
});
