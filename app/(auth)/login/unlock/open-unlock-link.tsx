"use client";

import { useState } from "react";

// Opens an unlock link (RT-04): reads the token from the URL fragment only when asked, removes it from the address
// bar, and posts it. The browser that does this gets the fresh sign-in budget.
export function OpenUnlockLink() {
  const [state, setState] = useState<"idle" | "working" | "done" | "failed" | "no-link">("idle");

  async function unlock() {
    const token = window.location.hash.slice(1);
    history.replaceState(null, "", window.location.pathname);
    if (!token) return setState("no-link");
    setState("working");
    const res = await fetch("/api/auth/unlock/confirm", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token }),
    }).catch(() => null);
    setState(res?.ok ? "done" : "failed");
  }

  if (state === "done") {
    return (
      <p role="status" className="rounded border border-green-300 bg-green-50 px-3 py-2 text-sm text-green-800">
        This browser can try signing in again. You still need your password and your authenticator code.{" "}
        <a href="/login" className="underline">
          Sign in
        </a>
      </p>
    );
  }
  return (
    <div className="space-y-2">
      <button type="button" onClick={unlock} disabled={state === "working"} className="w-full rounded border border-zinc-900 px-4 py-2">
        I opened an unlock link: unlock this browser
      </button>
      {state === "failed" && <p role="alert" className="text-sm text-red-800">This unlock link is invalid or has expired.</p>}
      {state === "no-link" && <p role="alert" className="text-sm text-red-800">Open this page from the link in your unlock email.</p>}
    </div>
  );
}
