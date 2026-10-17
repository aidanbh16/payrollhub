import { SESSION_COOKIE } from "@/application/auth/cookie-names";
import { clearSessionCookie, ensureDeviceId, setSessionCookie } from "@/application/auth/session-cookies";
import { redirectTo } from "@/application/http/forms";
import { route } from "@/application/http/route";
import { signInTenantParams, ssoCallbackForm } from "@/application/validation/auth";
import { TTL, revokeSessionCookie } from "@/services/identity/sessions";
import { signInWithSso } from "@/services/identity/sso";

// Assertion consumer for employee SSO (L1-20). The tenant in the path only selects which IdP configuration to verify
// against; the assertion's own signed tid claim must name the same tenant before any session is created.
export const POST = route.public({
  params: signInTenantParams,
  body: { type: "form", schema: ssoCallbackForm },
  handler: async ({ request, params, body }) => {
    const ok = redirectTo(request, "/employee");
    const deviceId = ensureDeviceId(request, ok);
    revokeSessionCookie(request.cookies.get(SESSION_COOKIE)?.value);
    const cookie = await signInWithSso({ tenantId: params.tenantId, assertion: body.assertion, deviceId });
    if (!cookie) {
      const failed = redirectTo(request, "/login?error=sso");
      clearSessionCookie(failed);
      return failed;
    }
    setSessionCookie(ok, cookie, TTL.employee);
    return ok;
  },
});
