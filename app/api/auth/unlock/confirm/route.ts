import { NextResponse } from "next/server";
import { setUnlockCookie } from "@/application/auth/session-cookies";
import { route } from "@/application/http/route";
import { unlockConfirmBody } from "@/application/validation/auth";
import { randomToken } from "@/services/identity/sessions";
import { confirmUnlock } from "@/services/identity/unlock";

// Opens an unlock link (RT-04, D46): the browser sending this request gets a fresh sign-in budget for the account the
// link was for, as a new random unlock cookie. Single-use; an unknown, used, or expired link gets one generic answer.
// Nothing else changes: no session is created, and signing in still needs the password and the TOTP code.
export const POST = route.public({
  body: { type: "json", schema: unlockConfirmBody },
  handler: async ({ body }) => {
    const cookie = randomToken();
    await confirmUnlock(body.token, cookie);
    const res = NextResponse.json({ unlocked: true }, { headers: { "Cache-Control": "no-store" } });
    setUnlockCookie(res, cookie);
    return res;
  },
});
