"use client";

import Link from "next/link";
import { Message, Section } from "@/app/_components/console-shell";
import { dateTime, dollars, useApi } from "@/app/_components/client-api";
import type { BatchStatusView } from "@/services/ach/ach-service";
import type { RunReview as Review } from "@/services/engine/engine-service";
import { ApproveRun } from "./approve-run";
import { SendToBank } from "./send-to-bank";

const FAILURES: Record<string, string> = {
  content_changed: "pay data changed after approval; approve again to run it",
  computation_error: "the computation failed; approve again to run it",
  bank_account_changed: "a bank account changed after it was computed; this run is closed, so ask HR to create a new run",
};

export function RunReview({ tenantId, runId }: { tenantId: string; runId: string }) {
  const base = `/api/tenants/${encodeURIComponent(tenantId)}/runs/${encodeURIComponent(runId)}`;
  const { data, error, reload } = useApi<Review & { batch: BatchStatusView | null }>(`${base}/review`);
  if (error) return <Message kind="error">{error}</Message>;
  if (!data) return <p className="text-sm text-zinc-600">Loading…</p>;
  const { run, results, exceptions, totals, batch } = data;
  const canApprove = run.status === "draft" || (run.status === "failed" && run.failureReason !== "bank_account_changed");

  return (
    <>
      <p className="text-sm">
        <Link href="/approver" className="underline">
          All runs
        </Link>
      </p>
      <Section title={`Pay date ${run.payDate}`}>
        <dl className="grid grid-cols-[10rem_1fr] gap-y-1 text-sm">
          <dt className="text-zinc-600">Status</dt>
          <dd className="uppercase" data-testid="run-status">
            {run.status}
          </dd>
          <dt className="text-zinc-600">Scheduled run date</dt>
          <dd>{run.scheduledRunDate} (a day before the pay date)</dd>
          {run.computedAt && (
            <>
              <dt className="text-zinc-600">Computed</dt>
              <dd>{dateTime(run.computedAt)}</dd>
            </>
          )}
        </dl>
        {run.late && (
          <Message kind="warning">
            <strong>Late (D29):</strong>{" "}
            {run.computedAt ? "this run was computed after" : "starting this run now would be after"} its scheduled run date ({run.scheduledRunDate}). It
            still proceeds, but the bank batch may settle after the pay date.
          </Message>
        )}
        {run.status === "failed" && <Message kind="error">This run failed: {FAILURES[run.failureReason ?? ""] ?? "unknown reason"}.</Message>}
        {canApprove && <ApproveRun tenantId={tenantId} runId={runId} onComputed={reload} />}
      </Section>

      {results.length > 0 && (
        <Section title="Pay results">
          <table className="w-full text-left text-sm">
            <thead className="text-zinc-600">
              <tr>
                <th className="py-1">Employee</th>
                <th className="text-right">Gross</th>
                <th className="text-right">Withholding</th>
                <th className="text-right">Net</th>
                <th className="text-right">Paid to</th>
              </tr>
            </thead>
            <tbody>
              {results.map((r) => (
                <tr key={r.employeeId} className="border-t border-zinc-100">
                  <td className="py-2">{r.name}</td>
                  <td className="text-right">{dollars(r.grossPayCents)}</td>
                  <td className="text-right">{dollars(r.withholdingCents)}</td>
                  <td className="text-right">{dollars(r.netPayCents)}</td>
                  <td className="text-right">{r.accountLast4 ? `ending in ${r.accountLast4}` : "?"}</td>
                </tr>
              ))}
              <tr className="border-t-2 border-zinc-300 font-medium" data-testid="totals">
                <td className="py-2">Total ({totals.employees} employees)</td>
                <td className="text-right">{dollars(totals.grossPayCents)}</td>
                <td className="text-right">{dollars(totals.withholdingCents)}</td>
                <td className="text-right">{dollars(totals.netPayCents)}</td>
                <td />
              </tr>
            </tbody>
          </table>
          {exceptions.length === 0 ? (
            <p className="text-sm text-zinc-600">No exceptions: every active employee is paid.</p>
          ) : (
            <Message kind="warning">
              Not paid ({exceptions.length}):{" "}
              {exceptions.map((e) => `${e.name} (${e.reason === "no_verified_bank_account" ? "no verified bank account" : e.reason})`).join(", ")}.
            </Message>
          )}
        </Section>
      )}

      {(run.status === "computed" || batch) && (
        <Section title="Bank">
          {batch?.status === "sent" ? (
            <Message kind="success">
              Sent to the bank: {batch.entryCount} payment(s), {dollars(batch.totalCreditCents ?? 0)}. Bank reference {batch.bankReference}
              {batch.sentAt ? `, ${dateTime(batch.sentAt)}` : ""}.
            </Message>
          ) : (
            <SendToBank tenantId={tenantId} runId={runId} onSent={reload} />
          )}
        </Section>
      )}
    </>
  );
}
