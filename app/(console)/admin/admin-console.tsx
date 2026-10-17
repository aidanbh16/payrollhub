"use client";

import { useState, type FormEvent } from "react";
import { Message, Section } from "@/app/_components/console-shell";
import { api, dateTime, useApi } from "@/app/_components/client-api";
import type { EmployeeAccountView } from "@/services/bank-account/bank-account-service";
import type { RunView } from "@/services/engine/engine-service";

// HR Admin: employees (pay accounts as last 4 digits; pending changes shown as unverified), bank-change requests for
// an employee (DV-39), and draft payroll runs. An HR Admin's change is only ever pending: the employee confirms it
// from their own email (L2-11).

export function AdminConsole({ tenantId }: { tenantId: string }) {
  const base = `/api/tenants/${encodeURIComponent(tenantId)}`;
  return (
    <>
      <Employees base={base} />
      <Runs base={base} />
    </>
  );
}

function Employees({ base }: { base: string }) {
  const { data, error, reload } = useApi<{ employees: EmployeeAccountView[] }>(`${base}/employees`);
  const [editing, setEditing] = useState<string | null>(null);
  return (
    <Section title="Employees">
      {error && <Message kind="error">{error}</Message>}
      {!data && !error && <p className="text-sm text-zinc-600">Loading…</p>}
      {data && (
        <table className="w-full text-left text-sm">
          <thead className="text-zinc-600">
            <tr>
              <th className="py-1">Name</th>
              <th>Email</th>
              <th>Pay account</th>
              <th>Pending change</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {data.employees.map((e) => (
              <tr key={e.employeeId} className="border-t border-zinc-100 align-top" data-testid={`employee-${e.email}`}>
                <td className="py-2">{e.fullName}</td>
                <td>{e.email}</td>
                <td>{e.account ? `ending in ${e.account.accountLast4}` : "none verified"}</td>
                <td>
                  {e.pending ? (
                    <span className="text-amber-800">
                      ending in {e.pending.accountLast4}: <strong>unverified</strong>, waiting for the employee to confirm (requested by{" "}
                      {e.pending.requestedBy === "employee" ? "the employee" : "HR"}, {dateTime(e.pending.requestedAt)})
                    </span>
                  ) : (
                    "none"
                  )}
                  {editing === e.employeeId && (
                    <ChangeForm
                      action={`${base}/employees/${encodeURIComponent(e.employeeId)}/bank-account/changes`}
                      onDone={() => {
                        setEditing(null);
                        reload();
                      }}
                    />
                  )}
                </td>
                <td className="text-right">
                  {editing !== e.employeeId && (
                    <button onClick={() => setEditing(e.employeeId)} className="rounded border border-zinc-300 px-2 py-1">
                      Request bank change
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Section>
  );
}

function ChangeForm({ action, onDone }: { action: string; onDone: () => void }) {
  const [routingNumber, setRouting] = useState("");
  const [accountNumber, setAccount] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api(action, { method: "POST", body: { routingNumber, accountNumber } });
      onDone();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="mt-2 space-y-2 rounded border border-zinc-200 p-2">
      <p className="text-xs text-zinc-600">The employee must confirm the change from their email before it is ever paid.</p>
      <label className="block">
        <span className="text-xs text-zinc-600">Routing number</span>
        <input value={routingNumber} onChange={(e) => setRouting(e.target.value)} inputMode="numeric" autoComplete="off" required className="mt-1 block w-full rounded border border-zinc-300 px-2 py-1" />
      </label>
      <label className="block">
        <span className="text-xs text-zinc-600">Account number</span>
        <input value={accountNumber} onChange={(e) => setAccount(e.target.value)} inputMode="numeric" autoComplete="off" required className="mt-1 block w-full rounded border border-zinc-300 px-2 py-1" />
      </label>
      <button disabled={busy} className="rounded bg-zinc-900 px-3 py-1 text-white disabled:opacity-50">
        Send for employee confirmation
      </button>
      {error && <Message kind="error">{error}</Message>}
    </form>
  );
}

function Runs({ base }: { base: string }) {
  const { data, error, reload } = useApi<{ runs: RunView[] }>(`${base}/runs`);
  const [payDate, setPayDate] = useState("");
  const [message, setMessage] = useState<{ kind: "error" | "success"; text: string } | null>(null);

  async function create(event: FormEvent) {
    event.preventDefault();
    setMessage(null);
    try {
      const run = await api<RunView>(`${base}/runs`, { method: "POST", body: { payDate } });
      setMessage({ kind: "success", text: `Draft run created for ${run.payDate}. A Payroll Approver must approve it.` });
      setPayDate("");
      reload();
    } catch (e) {
      setMessage({ kind: "error", text: (e as Error).message });
    }
  }

  return (
    <Section title="Payroll runs">
      <form onSubmit={create} className="flex items-end gap-2">
        <label className="block">
          <span className="text-xs text-zinc-600">Pay date</span>
          <input type="date" value={payDate} onChange={(e) => setPayDate(e.target.value)} required className="mt-1 block rounded border border-zinc-300 px-2 py-1" />
        </label>
        <button className="rounded bg-zinc-900 px-3 py-1.5 text-sm text-white">Create draft run</button>
      </form>
      {message && <Message kind={message.kind}>{message.text}</Message>}
      {error && <Message kind="error">{error}</Message>}
      {data && data.runs.length === 0 && <p className="text-sm text-zinc-600">No payroll runs yet.</p>}
      {data && data.runs.length > 0 && (
        <table className="w-full text-left text-sm">
          <thead className="text-zinc-600">
            <tr>
              <th className="py-1">Pay date</th>
              <th>Runs on</th>
              <th>Status</th>
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
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Section>
  );
}
