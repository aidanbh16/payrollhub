import { route } from "@/application/http/route";
import { mintAsBff } from "@/application/mint-as-bff";
import { listEmployeeAccounts } from "@/services/bank-account/bank-account-service";

// The HR Admin's employee list: pay accounts as last 4 digits only, and pending changes marked as unverified.
export const GET = route.session({
  roles: ["hr_admin"],
  tenantInPath: true,
  handler: async ({ tenantId }) => ({ employees: await listEmployeeAccounts(await mintAsBff("bankAccount.adminList", tenantId), { tenantId }) }),
});
