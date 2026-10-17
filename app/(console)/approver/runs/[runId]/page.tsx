import { notFound } from "next/navigation";
import { ConsoleShell } from "@/app/_components/console-shell";
import { requirePageSession } from "@/application/auth/dal";
import { runParams } from "@/application/validation/runs";
import { RunReview } from "../../run-review";

// One run, for the Payroll Approver: review, approve with MFA step-up, run payroll, review results, send to the bank.
export default async function RunPage({ params }: { params: Promise<{ runId: string }> }) {
  const claims = await requirePageSession(["approver"]);
  const parsed = runParams.safeParse(await params);
  if (!parsed.success) notFound();
  return (
    <ConsoleShell claims={claims} title="Review payroll run">
      <RunReview tenantId={claims.tenantId} runId={parsed.data.runId} />
    </ConsoleShell>
  );
}
