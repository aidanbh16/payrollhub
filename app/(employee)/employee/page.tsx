import { ConsoleShell } from "@/app/_components/console-shell";
import { requirePageSession } from "@/application/auth/dal";
import { EmployeePortal } from "./employee-portal";

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

// Employee portal (Section 2.1). An employee session is accepted here and nowhere in the consoles. Data comes from the
// route handlers, which select the employee from the session, never from the request.
export default async function EmployeePage({ searchParams }: { searchParams: SearchParams }) {
  const claims = await requirePageSession(["employee"]);
  const { bank } = await searchParams;
  return (
    <ConsoleShell claims={claims} title="Employee portal">
      <EmployeePortal tenantId={claims.tenantId} notice={typeof bank === "string" ? bank : null} />
    </ConsoleShell>
  );
}
