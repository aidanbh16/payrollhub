import { NextResponse } from "next/server";
import { redirectTo } from "@/application/http/forms";
import { route } from "@/application/http/route";
import { idpLoginForm, signInTenantParams } from "@/application/validation/auth";
import { authenticateAtIdp, issueAssertion } from "@/partners/mock-idp/idp";

// The stand-in IdP's own login form handler. It is listed in edge/login-routes.ts so the Layer 4 per-account rate
// limiter covers it like PayrollHub's own login (L1-05).
const escapeHtml = (value: string) =>
  value.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

export const POST = route.public({
  params: signInTenantParams,
  body: { type: "form", schema: idpLoginForm },
  handler: async ({ request, params, body }) => {
    const { tenantId } = params;
    const subject = await authenticateAtIdp(tenantId, body.email, body.password);
    if (!subject) return redirectTo(request, `/mock-idp/${tenantId}?error=1`);

    // Like the SAML POST binding: the browser carries the signed assertion to PayrollHub's assertion consumer.
    const assertion = await issueAssertion(tenantId, subject);
    const action = `/api/auth/sso/${tenantId}/callback`;
    const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Signed in</title></head>
<body>
  <p>Signed in at the ${escapeHtml(tenantId)} identity provider as ${escapeHtml(body.email)}.</p>
  <form method="post" action="${escapeHtml(action)}">
    <input type="hidden" name="assertion" value="${escapeHtml(assertion)}">
    <button type="submit">Continue to PayrollHub</button>
  </form>
</body></html>`;
    return new NextResponse(html, { headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" } });
  },
});
