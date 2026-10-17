import { SESSION_COOKIE } from "@/application/auth/cookie-names";
import { clearSessionCookie } from "@/application/auth/session-cookies";
import { redirectTo } from "@/application/http/forms";
import { route } from "@/application/http/route";
import { emptyForm } from "@/application/validation/auth";
import { revokeSessionCookie } from "@/services/identity/sessions";

// Logout sets revoked_at, so the session is dead on the server immediately, not just removed from this browser.
export const POST = route.public({
  body: { type: "form", schema: emptyForm },
  handler: ({ request }) => {
    revokeSessionCookie(request.cookies.get(SESSION_COOKIE)?.value);
    const res = redirectTo(request, "/login");
    clearSessionCookie(res);
    return res;
  },
});
