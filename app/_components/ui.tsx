import type { ReactNode } from "react";

// Shared UI for the sign-in pages. Signed-in pages use console-shell.tsx.

export function Shell({ title, children }: { title: string; children: ReactNode }) {
  return (
    <main className="mx-auto w-full max-w-md px-6 py-16">
      <h1 className="text-2xl font-semibold">{title}</h1>
      <div className="mt-6 space-y-6">{children}</div>
    </main>
  );
}

export function Field({ label, name, type = "text", autoComplete }: { label: string; name: string; type?: string; autoComplete?: string }) {
  return (
    <label className="block">
      <span className="text-sm text-zinc-700">{label}</span>
      <input
        name={name}
        type={type}
        autoComplete={autoComplete}
        required
        className="mt-1 block w-full rounded border border-zinc-300 bg-white px-3 py-2"
      />
    </label>
  );
}

export function Submit({ children }: { children: ReactNode }) {
  return <button className="w-full rounded bg-zinc-900 px-4 py-2 text-white">{children}</button>;
}

export function Notice({ children }: { children: ReactNode }) {
  return <p role="alert" className="rounded border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-800">{children}</p>;
}
