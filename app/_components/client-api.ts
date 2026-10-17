"use client";

import { useCallback, useEffect, useState } from "react";

// The UI's only way to get or change data: same-origin calls to the route handlers (Section 2.1). Responses are never
// cached. A 401 (signed out or expired) sends the browser to sign-in. Errors shown to the user are the server's own
// generic messages; nothing else is echoed.

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export async function api<T>(url: string, init: { method?: "GET" | "POST"; body?: unknown } = {}): Promise<T> {
  const res = await fetch(url, {
    method: init.method ?? "GET",
    headers: init.body !== undefined ? { "content-type": "application/json" } : undefined,
    body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
    cache: "no-store",
    credentials: "same-origin",
  });
  if (res.status === 401) {
    window.location.replace("/login");
    throw new ApiError(401, "Your session has ended. Sign in again.");
  }
  const body = (await res.json().catch(() => ({}))) as T & { error?: string; reason?: string };
  if (!res.ok) {
    const message = res.status === 404 ? "Not found." : (body.error ?? "Something went wrong. Try again.");
    throw new ApiError(res.status, body.reason ? `${message} (${body.reason})` : message);
  }
  return body;
}

/** Loads a route handler's JSON once, with a reload function. */
export function useApi<T>(url: string) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const reload = useCallback(() => {
    api<T>(url)
      .then((d) => {
        setData(d);
        setError(null);
      })
      .catch((e: Error) => setError(e.message));
  }, [url]);
  useEffect(reload, [reload]);
  return { data, error, reload };
}

export const dollars = (cents: number) => (cents / 100).toLocaleString("en-US", { style: "currency", currency: "USD" });

export const dateTime = (iso: string) => new Date(iso).toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" });
