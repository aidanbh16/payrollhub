"use client";

import { useEffect, useRef, useState } from "react";
import { Message, Section } from "@/app/_components/console-shell";
import { api, dateTime } from "@/app/_components/client-api";
import type { ChangeView } from "@/services/bank-account/bank-account-service";

// Reads the link token from the address bar once, keeps it in memory, and removes it from the URL (so it is not left
// in history, a bookmark, or a screenshot). Shows the change via a read-only POST; Confirm and Reject are form POSTs
// carrying the token, which the server checks against the signed-in employee, the change, and its expiry.
export function ConfirmChange({ tenantId, changeId }: { tenantId: string; changeId: string }) {
  const [token, setToken] = useState<string | null>(null);
  const [view, setView] = useState<ChangeView | null>(null);
  const [error, setError] = useState<string | null>(null);
  // The token as first read from the address bar. Kept in a ref because React runs this effect twice under `next dev`
  // (Strict Mode), and by the second run the first has already removed the token from the URL.
  const linkToken = useRef<string | null | undefined>(undefined);

  useEffect(() => {
    if (linkToken.current === undefined) {
      linkToken.current = new URLSearchParams(window.location.search).get("token");
      if (linkToken.current) window.history.replaceState(null, "", window.location.pathname);
    }
    const fromUrl = linkToken.current;
    let current = true;
    const load = async (): Promise<ChangeView> => {
      if (!fromUrl || fromUrl.length > 128) throw new Error("no-token");
      return api<ChangeView>(`/api/tenants/${encodeURIComponent(tenantId)}/bank-account/changes/${encodeURIComponent(changeId)}/view`, {
        method: "POST",
        body: { token: fromUrl },
      });
    };
    load()
      .then((v) => {
        if (!current) return;
        setToken(fromUrl);
        setView(v);
      })
      .catch((e: Error) => {
        if (!current) return;
        setError(
          e.message === "no-token"
            ? "Open the confirmation link from your email to see this change."
            : "This confirmation link is invalid, already used, replaced by a newer request, or expired.",
        );
      });
    return () => {
      current = false;
    };
  }, [tenantId, changeId]);

  if (error) return <Message kind="error">{error}</Message>;
  if (!view || !token) return <p className="text-sm text-zinc-600">Loading…</p>;
  const action = (decision: string) => `/api/tenants/${encodeURIComponent(tenantId)}/bank-account/changes/${encodeURIComponent(changeId)}/${decision}`;

  return (
    <Section title="Pay account change">
      <p className="text-sm">
        {view.requestedBy === "you" ? "You" : "Your HR administrator"} asked to send your pay to a new account ending in{" "}
        <strong data-testid="new-last4">{view.accountLast4}</strong> ({dateTime(view.requestedAt)}).
      </p>
      <p className="text-sm">If you did not ask for this, reject it and contact HR. This link expires {dateTime(view.expiresAt)}.</p>
      <div className="flex gap-3">
        <form method="post" action={action("confirm")}>
          <input type="hidden" name="token" value={token} />
          <button className="rounded bg-zinc-900 px-4 py-2 text-sm text-white">Confirm new account</button>
        </form>
        <form method="post" action={action("reject")}>
          <input type="hidden" name="token" value={token} />
          <button className="rounded border border-zinc-300 px-4 py-2 text-sm">Reject</button>
        </form>
      </div>
    </Section>
  );
}
