"use client";

import Link from "next/link";
import { Message, Section } from "@/app/_components/console-shell";
import { dateTime, dollars, useApi } from "@/app/_components/client-api";
import type { PayStatement } from "@/services/engine/engine-service";

// The employee's own pay statements and pay account, and a bank-change request (stored as pending until the employee
// confirms it from the link in their email; L2-11).

const NOTICES: Record<string, { kind: "success" | "error" | "info"; text: string }> = {
  requested: { kind: "info", text: "Change requested. We sent a confirmation link to your email. Until you confirm it, your pay keeps going to your current account." },
  invalid: { kind: "error", text: "That routing or account number is not valid. Nothing was changed." },
  confirmed: { kind: "success", text: "Your new pay account is confirmed." },
  rejected: { kind: "info", text: "The change was rejected. Your pay account is unchanged." },
  "link-invalid": { kind: "error", text: "That confirmation link is invalid, already used, replaced by a newer request, or expired." },
};

interface BankSummary {
  current: { accountLast4: string; verifiedAt: string } | null;
  pending: { changeId: string; accountLast4: string; requestedAt: string } | null;
}

export function EmployeePortal({ tenantId, notice }: { tenantId: string; notice: string | null }) {
  const base = `/api/tenants/${encodeURIComponent(tenantId)}`;
  const statements = useApi<{ statements: PayStatement[] }>(`${base}/me/pay-statements`);
  const bank = useApi<BankSummary>(`${base}/me/bank-account`);
  const shown = notice ? NOTICES[notice] : undefined;

  return (
    <>
      {shown && <Message kind={shown.kind}>{shown.text}</Message>}
      <Section title="Pay statements">
        {statements.error && <Message kind="error">{statements.error}</Message>}
        {statements.data && statements.data.statements.length === 0 && <p className="text-sm text-zinc-600">No pay statements yet.</p>}
        {statements.data && statements.data.statements.length > 0 && (
          <table className="w-full text-left text-sm">
            <thead className="text-zinc-600">
              <tr>
                <th className="py-1">Pay date</th>
                <th className="text-right">Net pay</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {statements.data.statements.map((s) => (
                <tr key={s.resultId} className="border-t border-zinc-100">
                  <td className="py-2">{s.payDate}</td>
                  <td className="text-right">{dollars(s.netPayCents)}</td>
                  <td className="text-right">
                    <Link href={`/employee/statements/${s.resultId}`} className="underline">
                      View statement
                    </Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Section>

      <Section title="Pay account">
        {bank.error && <Message kind="error">{bank.error}</Message>}
        {bank.data && (
          <div className="space-y-2 text-sm" data-testid="pay-account">
            <p>{bank.data.current ? `Account ending in ${bank.data.current.accountLast4}` : "No verified account on file."}</p>
            {bank.data.pending && (
              <Message kind="warning">
                Pending change to an account ending in {bank.data.pending.accountLast4} (requested {dateTime(bank.data.pending.requestedAt)}). It is
                <strong> unverified</strong> and will not be paid until you confirm it from the link in your email.
              </Message>
            )}
          </div>
        )}
        <form method="post" action={`${base}/bank-account/changes`} className="space-y-3 border-t border-zinc-100 pt-3">
          <h3 className="text-sm font-medium">Change pay account</h3>
          <label className="block">
            <span className="text-sm text-zinc-700">Routing number</span>
            <input name="routingNumber" inputMode="numeric" autoComplete="off" required className="mt-1 block w-full max-w-xs rounded border border-zinc-300 px-3 py-2" />
          </label>
          <label className="block">
            <span className="text-sm text-zinc-700">Account number</span>
            <input name="accountNumber" inputMode="numeric" autoComplete="off" required className="mt-1 block w-full max-w-xs rounded border border-zinc-300 px-3 py-2" />
          </label>
          <button className="rounded bg-zinc-900 px-4 py-2 text-sm text-white">Request change</button>
        </form>
      </Section>
    </>
  );
}
