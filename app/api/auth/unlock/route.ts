import { redirectTo } from "@/application/http/forms";
import { route } from "@/application/http/route";
import { unlockRequestForm } from "@/application/validation/auth";
import { requestUnlock } from "@/services/identity/unlock";

// Asks for an unlock link (RT-04, D46). The same redirect whatever the organization or email: whether the account
// exists, and whether a mail was sent, are never revealed. Proxy limits it per targeted account (staff-unlock).
export const POST = route.public({
  body: { type: "form", schema: unlockRequestForm },
  handler: async ({ request, body }) => {
    await requestUnlock(body);
    return redirectTo(request, "/login/unlock?sent=1");
  },
});
