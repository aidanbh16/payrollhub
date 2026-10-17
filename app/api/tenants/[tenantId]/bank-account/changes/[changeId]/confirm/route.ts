import { redirectTo } from "@/application/http/forms";
import { route } from "@/application/http/route";
import { mintAsBff } from "@/application/mint-as-bff";
import { changeParams, linkTokenForm } from "@/application/validation/bank";
import { resolveBankChange } from "@/services/bank-account/bank-account-service";
import { NotFoundError } from "@/services/errors";

// The employee confirms a pending bank change from the page their email link opened. POST only, so a link scanner
// or prefetch (GET) can never confirm it; the route wrapper refuses cross-site posts, and the session cookie is
// SameSite=Strict. Needs both the signed-in employee the change is for and the unused, unexpired link token.
export const POST = route.session({
  roles: ["employee"],
  tenantInPath: true,
  params: changeParams,
  body: { type: "form", schema: linkTokenForm },
  handler: async ({ request, session, tenantId, params, body }) => {
    try {
      await resolveBankChange(await mintAsBff("bankAccount.resolveChange", tenantId), {
        tenantId,
        employeeUserId: session.userId,
        changeId: params.changeId,
        token: body.token,
        decision: "confirm",
      });
    } catch (err) {
      if (err instanceof NotFoundError) return redirectTo(request, "/employee?bank=link-invalid");
      throw err;
    }
    return redirectTo(request, "/employee?bank=confirmed");
  },
});
