import { ConsoleShell } from "@/app/_components/console-shell";
import { requirePageSession } from "@/application/auth/dal";
import { AdminConsole } from "./admin-console";

// HR Admin console (Section 2.1). The page only checks the session (an employee or approver is sent to their own
// home); everything shown is fetched from the route handlers by the client component.
export default async function AdminPage() {
  const claims = await requirePageSession(["hr_admin"]);
  return (
    <ConsoleShell claims={claims} title="HR Admin console">
      <AdminConsole tenantId={claims.tenantId} />
    </ConsoleShell>
  );
}
