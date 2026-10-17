import { notFound } from "next/navigation";
import { ConsoleShell } from "@/app/_components/console-shell";
import { requirePageSession } from "@/application/auth/dal";
import { changeParams } from "@/application/validation/bank";
import { ConfirmChange } from "./confirm-change";

// The page an emailed confirmation link opens (D13). Opening it only SHOWS the change; Confirm and Reject are POSTs.
// The URL carries the link token, so this page, like every page, is Referrer-Policy: no-referrer and loads nothing from
// any other origin (the CSP allows only this origin). The client component moves the token out of the address bar.
export default async function BankChangePage({ params }: { params: Promise<{ changeId: string }> }) {
  const claims = await requirePageSession(["employee"]);
  const parsed = changeParams.safeParse(await params);
  if (!parsed.success) notFound();
  return (
    <ConsoleShell claims={claims} title="Confirm a pay account change">
      <ConfirmChange tenantId={claims.tenantId} changeId={parsed.data.changeId} />
    </ConsoleShell>
  );
}
