import { route } from "@/application/http/route";
import { mintAsBff } from "@/application/mint-as-bff";
import { changeParams, linkTokenForm } from "@/application/validation/bank";
import { viewBankChange } from "@/services/bank-account/bank-account-service";

// What the confirmation page shows (last 4 digits of the new account). Read-only: it confirms nothing. The link token
// travels in the POST body, not in this URL, so it never lands in another URL or a server log.
export const POST = route.session({
  roles: ["employee"],
  tenantInPath: true,
  params: changeParams,
  body: { type: "json", schema: linkTokenForm },
  handler: async ({ session, tenantId, params, body }) => ({
    ...(await viewBankChange(await mintAsBff("bankAccount.viewChange", tenantId), {
      tenantId,
      employeeUserId: session.userId,
      changeId: params.changeId,
      token: body.token,
    })),
  }),
});
