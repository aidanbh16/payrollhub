import { redirectTo } from "@/application/http/forms";
import { route } from "@/application/http/route";
import { mintAsBff } from "@/application/mint-as-bff";
import { bankDetailsBody } from "@/application/validation/bank";
import { getBankSummary, requestBankChange } from "@/services/bank-account/bank-account-service";
import { InvalidInputError } from "@/services/errors";

// An employee asks to change their own pay account (Section 2.1). The change is stored as pending and is never paid
// until they confirm it from their own email (L2-11). Money-redirecting: Proxy fails closed if Redis is down.
export const POST = route.session({
  roles: ["employee"],
  tenantInPath: true,
  body: { type: "form", schema: bankDetailsBody },
  handler: async ({ request, session, tenantId, body }) => {
    const { employeeId } = await getBankSummary(await mintAsBff("bankAccount.summary", tenantId), { tenantId, employeeUserId: session.userId });
    try {
      await requestBankChange(await mintAsBff("bankAccount.requestChange", tenantId), { tenantId, employeeId, requestedBy: session.userId, ...body });
    } catch (err) {
      if (err instanceof InvalidInputError) return redirectTo(request, "/employee?bank=invalid");
      throw err;
    }
    return redirectTo(request, "/employee?bank=requested");
  },
});
