import { DEVICE_COOKIE, SESSION_COOKIE } from "@/application/auth/cookie-names";
import { homeFor } from "@/application/auth/dal";
import { clearSessionCookie, setKnownDeviceCookie, setSessionCookie } from "@/application/auth/session-cookies";
import { redirectTo } from "@/application/http/forms";
import { route } from "@/application/http/route";
import { mfaForm } from "@/application/validation/auth";
import { completeStaffLogin } from "@/services/identity/login";
import { KNOWN_DEVICE_COOKIE, KNOWN_DEVICE_TTL_MS, accountHash, rememberKnownDevice } from "@/edge/known-devices";
import { TTL, isWellFormedToken, randomToken } from "@/services/identity/sessions";
import { log } from "@/data/log/logger";

// Staff sign-in, step 2 (TOTP code). On success the pending session is replaced by a new, MFA-verified session id.
// On any failure the pending session is spent and the user starts again with the same generic message.
export const POST = route.public({
  body: { type: "form", schema: mfaForm },
  handler: async ({ request, body }) => {
    const result = completeStaffLogin({
      pendingCookie: request.cookies.get(SESSION_COOKIE)?.value,
      deviceId: request.cookies.get(DEVICE_COOKIE)?.value,
      code: body.code,
    });
    if (!result) {
      const res = redirectTo(request, "/login?error=signin");
      clearSessionCookie(res);
      return res;
    }
    const res = redirectTo(request, homeFor(result.role));
    setSessionCookie(res, result.cookie, TTL.privileged);
    // D25: only now, after a successful MFA step, is this browser recorded as a known device for this account.
    const existing = request.cookies.get(KNOWN_DEVICE_COOKIE)?.value;
    const device = isWellFormedToken(existing) ? existing : randomToken();
    try {
      await rememberKnownDevice(accountHash(result.tenantId, result.email), device);
      setKnownDeviceCookie(res, device, KNOWN_DEVICE_TTL_MS);
    } catch {
      log.warn("auth.known_device_unavailable", { note: "Redis unavailable; sign-in continues without recording the device" });
    }
    return res;
  },
});
