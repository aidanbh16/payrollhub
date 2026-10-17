"use client";

import Link from "next/link";
import { Message, Section } from "@/app/_components/console-shell";
import { useApi } from "@/app/_components/client-api";
import type { RunView } from "@/services/engine/engine-service";

export function RunList({ tenantId }: { tenantId: string }) {
  const { data, error } = useApi<{ runs: RunView[] }>(`/api/tenants/${encodeURIComponent(tenantId)}/runs`);
  return (
    <Section title="Payroll runs">
      {error && <Message kind="error">{error}</Message>}
      {data && data.runs.length === 0 && <p className="text-sm text-zinc-600">No payroll runs yet.</p>}
      {data && data.runs.length > 0 && (
        <table className="w-full text-left text-sm">
          <thead className="text-zinc-600">
            <tr>
              <th className="py-1">Pay date</th>
              <th>Runs on</th>
              <th>Status</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {data.runs.map((r) => (
              <tr key={r.runId} className="border-t border-zinc-100">
                <td className="py-2">{r.payDate}</td>
                <td>{r.scheduledRunDate}</td>
                <td className="uppercase">
                  {r.status}
                  {r.late && <span className="ml-2 rounded bg-amber-100 px-1 text-xs normal-case text-amber-900">late</span>}
                </td>
                <td className="text-right">
                  <Link href={`/approver/runs/${r.runId}`} className="underline">
                    Review
                  </Link>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Section>
  );
}
