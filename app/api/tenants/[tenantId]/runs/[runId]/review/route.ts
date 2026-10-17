import { route } from "@/application/http/route";
import { mintAsBff } from "@/application/mint-as-bff";
import { runParams } from "@/application/validation/runs";
import { getBatchStatus } from "@/services/ach/ach-service";
import { reviewRun } from "@/services/engine/engine-service";
import { NotFoundError } from "@/services/errors";

// The approver's review of one run: status and late flag (D29), each employee's gross, withholding, and net pay with
// the account's last 4 digits, exceptions, totals, and the bank batch's status once sent. No full bank numbers.
export const GET = route.session({
  roles: ["approver"],
  tenantInPath: true,
  params: runParams,
  handler: async ({ tenantId, params }) => {
    const review = await reviewRun(await mintAsBff("engine.reviewRun", tenantId), { tenantId, runId: params.runId });
    let batch = null;
    try {
      batch = await getBatchStatus(await mintAsBff("ach.getBatch", tenantId), { tenantId, runId: params.runId });
    } catch (err) {
      if (!(err instanceof NotFoundError)) throw err;
    }
    return { ...review, batch };
  },
});
