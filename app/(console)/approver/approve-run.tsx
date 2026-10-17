"use client";

import { useEffect, useState, type FormEvent } from "react";
import { Message } from "@/app/_components/console-shell";
import { api } from "@/app/_components/client-api";

// Approve one run with an MFA step-up, then run payroll (Section 2.1; L2-01). On approval the server returns a signed,
// single-use approval token in the JSON body.
//
// The token lives ONLY in this component's React state, in memory: never in localStorage, sessionStorage, IndexedDB,
// or a cookie (ESLint bans those APIs in app code; the browser end-to-end test checks all four). Reloading or leaving
// the page discards it, and it expires on the server after 5 minutes regardless. "Run payroll" removes it from state
// before sending it once to start the run (Payroll Engine redeems it).

interface Approval {
  token: string;
  expiresAt: string;
}

export function ApproveRun({ tenantId, runId, onComputed }: { tenantId: string; runId: string; onComputed: () => void }) {
  const base = `/api/tenants/${encodeURIComponent(tenantId)}/runs/${encodeURIComponent(runId)}`;
  const [code, setCode] = useState("");
  const [approval, setApproval] = useState<Approval | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!approval) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [approval]);

  async function approve(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const body = await api<{ approvalToken: string; expiresAt: string }>(`${base}/approve`, { method: "POST", body: { code } });
      setApproval({ token: body.approvalToken, expiresAt: body.expiresAt });
      setNow(Date.now());
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setCode("");
      setBusy(false);
    }
  }

  async function runPayroll() {
    if (!approval) return;
    const approvalToken = approval.token;
    // Single-use: forget it now, whatever the answer.
    setApproval(null);
    setBusy(true);
    setError(null);
    try {
      await api(`${base}/start`, { method: "POST", body: { approvalToken } });
      onComputed();
    } catch (e) {
      setError((e as Error).message);
      onComputed(); // the run may now be failed; show its state
    } finally {
      setBusy(false);
    }
  }

  if (approval) {
    const secondsLeft = Math.max(0, Math.round((Date.parse(approval.expiresAt) - now) / 1000));
    return (
      <div className="space-y-2 text-sm">
        <Message kind="success">
          Approved. The single-use approval token is held in this page&apos;s memory only and{" "}
          {secondsLeft > 0 ? `expires in ${secondsLeft} s` : "has expired; approve again"}.
        </Message>
        <button onClick={runPayroll} disabled={busy || secondsLeft === 0} className="rounded bg-zinc-900 px-3 py-1.5 text-white disabled:opacity-50">
          Run payroll
        </button>
      </div>
    );
  }

  return (
    <form onSubmit={approve} className="space-y-2">
      <p className="text-sm text-zinc-700">Approving needs a fresh code from your authenticator app (step-up verification).</p>
      <div className="flex items-end gap-2">
        <label className="block">
          <span className="text-xs text-zinc-600">Authenticator code</span>
          <input
            value={code}
            onChange={(e) => setCode(e.target.value)}
            inputMode="numeric"
            autoComplete="one-time-code"
            required
            className="mt-1 block w-28 rounded border border-zinc-300 bg-white px-2 py-1"
          />
        </label>
        <button disabled={busy} className="rounded bg-zinc-900 px-3 py-1.5 text-sm text-white disabled:opacity-50">
          Approve
        </button>
      </div>
      {error && <Message kind="error">{error}</Message>}
    </form>
  );
}
