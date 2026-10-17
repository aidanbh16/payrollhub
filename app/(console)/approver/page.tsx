import { ConsoleShell } from "@/app/_components/console-shell";
import { requirePageSession } from "@/application/auth/dal";
import { RunList } from "./run-list";

// Payroll Approver console (Section 2.1): the tenant's runs; each opens a review page. Data comes from route handlers.
export default async function ApproverPage() {
  const claims = await requirePageSession(["approver"]);
  return (
    <ConsoleShell claims={claims} title="Payroll Approver console">
      <RunList tenantId={claims.tenantId} />
    </ConsoleShell>
  );
}
