import { redirectTo } from "@/application/http/forms";
import { route } from "@/application/http/route";
import { ssoStartQuery } from "@/application/validation/auth";
import { tenantIdParam } from "@/application/validation/common";

// Employee sign-in starts at the tenant's own identity provider (Section 2.1). Locally that is the stand-in IdP.
export const GET = route.public({
  query: ssoStartQuery,
  handler: ({ request, query }) => {
    const organization = tenantIdParam.safeParse(query.organization);
    if (!organization.success) return redirectTo(request, "/login?error=sso");
    return redirectTo(request, `/mock-idp/${organization.data}`);
  },
});
