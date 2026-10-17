import { route } from "@/application/http/route";

// HR Admin only. Returns who is signed in.
export const GET = route.session({
  roles: ["hr_admin"],
  handler: ({ session }) => ({
    tenantId: session.tenantId,
    email: session.email,
    role: session.role,
    mfaVerifiedAt: session.mfaVerifiedAt,
  }),
});
