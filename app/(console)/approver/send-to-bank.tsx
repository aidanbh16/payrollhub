"use client";

import { useState } from "react";
import { Message } from "@/app/_components/console-shell";
import { api } from "@/app/_components/client-api";

// "Send to bank" for a computed run (D33: the approver sends). The request carries nothing but the run: ACH
// Disbursement builds the batch from the run's pay results. Pressing again (or after a timeout) resends the same
// batch, never a new one.
export function SendToBank({ tenantId, runId, onSent }: { tenantId: string; runId: string; onSent: () => void }) {
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function send() {
    setBusy(true);
    setError(null);
    try {
      await api(`/api/tenants/${encodeURIComponent(tenantId)}/runs/${encodeURIComponent(runId)}/disburse`, { method: "POST", body: {} });
      onSent();
    } catch (e) {
      setError(`${(e as Error).message} Press again to retry: the same batch is resent.`);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-2 text-sm">
      <p className="text-zinc-700">Review the totals and exceptions above, then send the signed batch to the bank.</p>
      <button onClick={send} disabled={busy} className="rounded bg-zinc-900 px-3 py-1.5 text-white disabled:opacity-50">
        Send to bank
      </button>
      {error && <Message kind="error">{error}</Message>}
    </div>
  );
}
