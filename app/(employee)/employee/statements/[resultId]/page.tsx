import { notFound } from "next/navigation";
import { ConsoleShell } from "@/app/_components/console-shell";
import { requirePageSession } from "@/application/auth/dal";
import { statementParams } from "@/application/validation/runs";
import { Statement } from "./statement";

// One pay statement. The id in the URL only selects among the signed-in employee's own statements: the route handler
// answers "not found" for anyone else's.
export default async function StatementPage({ params }: { params: Promise<{ resultId: string }> }) {
  const claims = await requirePageSession(["employee"]);
  const parsed = statementParams.safeParse(await params);
  if (!parsed.success) notFound();
  return (
    <ConsoleShell claims={claims} title="Pay statement">
      <Statement tenantId={claims.tenantId} resultId={parsed.data.resultId} />
    </ConsoleShell>
  );
}
