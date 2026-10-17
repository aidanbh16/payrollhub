import { SESSION_COOKIE } from "@/application/auth/cookie-names";
import { ensureDeviceId, setSessionCookie } from "@/application/auth/session-cookies";
import { redirectTo } from "@/application/http/forms";
import { route } from "@/application/http/route";
import { staffLoginForm } from "@/application/validation/auth";
import { startStaffLogin } from "@/services/identity/login";
import { TTL, revokeSessionCookie } from "@/services/identity/sessions";

// Staff sign-in, step 1 (organization, email, password). The response is identical whatever was wrong:
// a 303 to the code step with a new session cookie. See services/identity/login.ts.
// Per-account rate limiting (L1-05) is applied in front of this route by Layer 4; see edge/login-routes.ts.
export const POST = route.public({
  body: { type: "form", schema: staffLoginForm },
  handler: async ({ request, body }) => {
    const res = redirectTo(request, "/login/mfa");
    const deviceId = ensureDeviceId(request, res);
    // A session presented at login is never carried forward: it is revoked and a new id is always issued.
    revokeSessionCookie(request.cookies.get(SESSION_COOKIE)?.value);
    setSessionCookie(res, await startStaffLogin({ ...body, deviceId }), TTL.pendingMfa);
    return res;
  },
});
