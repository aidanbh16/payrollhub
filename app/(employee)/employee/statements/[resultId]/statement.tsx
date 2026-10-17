"use client";

import Link from "next/link";
import { Message, Section } from "@/app/_components/console-shell";
import { dollars, useApi } from "@/app/_components/client-api";
import type { PayStatement } from "@/services/engine/engine-service";

export function Statement({ tenantId, resultId }: { tenantId: string; resultId: string }) {
  const { data, error } = useApi<PayStatement>(`/api/tenants/${encodeURIComponent(tenantId)}/me/pay-statements/${encodeURIComponent(resultId)}`);
  return (
    <>
      <p className="text-sm">
        <Link href="/employee" className="underline">
          Back to your portal
        </Link>
      </p>
      {error && <Message kind="error">{error === "Not found." ? "Statement not found." : error}</Message>}
      {data && (
        <Section title={`Pay date ${data.payDate}`}>
          <dl className="grid grid-cols-[10rem_1fr] gap-y-1 text-sm" data-testid="statement">
            <dt className="text-zinc-600">Gross pay</dt>
            <dd>{dollars(data.grossPayCents)}</dd>
            <dt className="text-zinc-600">Withholding</dt>
            <dd>{dollars(data.withholdingCents)}</dd>
            <dt className="text-zinc-600">Net pay</dt>
            <dd className="font-medium">{dollars(data.netPayCents)}</dd>
            <dt className="text-zinc-600">Paid to</dt>
            <dd>{data.accountLast4 ? `account ending in ${data.accountLast4}` : "?"}</dd>
            <dt className="text-zinc-600">Status</dt>
            <dd>{data.runStatus === "disbursed" ? "sent to the bank" : "computed, not yet sent"}</dd>
          </dl>
        </Section>
      )}
    </>
  );
}
