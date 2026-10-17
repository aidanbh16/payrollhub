import { NextResponse } from "next/server";
import { route } from "@/application/http/route";
import { mintAsBff } from "@/application/mint-as-bff";
import { bankDetailsBody, employeeParams } from "@/application/validation/bank";
import { requestBankChange } from "@/services/bank-account/bank-account-service";

// An HR Admin enters a bank change for an employee. It is stored as pending exactly like the employee's own request:
// only the employee, through the link in their own email, can make it the account they are paid into (L2-11, L0-01).
// The response carries the last 4 digits only, and never the confirmation link.
export const POST = route.session({
  roles: ["hr_admin"],
  tenantInPath: true,
  params: employeeParams,
  body: { type: "json", schema: bankDetailsBody },
  handler: async ({ session, tenantId, params, body }) => {
    const receipt = await requestBankChange(await mintAsBff("bankAccount.requestChange", tenantId), {
      tenantId,
      employeeId: params.employeeId,
      requestedBy: session.userId,
      ...body,
    });
    return NextResponse.json(receipt, { status: 201, headers: { "Cache-Control": "no-store" } });
  },
});
