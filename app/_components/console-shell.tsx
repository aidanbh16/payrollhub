import Link from "next/link";
import type { ReactNode } from "react";
import type { SessionClaims } from "@/services/identity/sessions";
import { BfcacheGuard } from "./bfcache-guard";

// Frame for every signed-in page: who is signed in, and sign-out. Text is rendered as text (React escapes it); there
// is no dangerouslySetInnerHTML anywhere in the app.

const ROLE_NAMES = { hr_admin: "HR Admin", approver: "Payroll Approver", employee: "Employee" } as const;
const HOME = { hr_admin: "/admin", approver: "/approver", employee: "/employee" } as const;

export function ConsoleShell({ claims, title, children }: { claims: SessionClaims; title: string; children: ReactNode }) {
  return (
    <div className="flex min-h-full flex-col">
      <BfcacheGuard />
      <header className="border-b border-zinc-200 bg-white">
        <div className="mx-auto flex w-full max-w-5xl items-center justify-between gap-4 px-6 py-3 text-sm">
          <Link href={HOME[claims.role]} className="font-semibold">
            PayrollHub
          </Link>
          <div className="flex items-center gap-4">
            <span className="text-zinc-600">
              {claims.email} · {ROLE_NAMES[claims.role]} · <code>{claims.tenantId}</code>
            </span>
            <form method="post" action="/api/auth/logout">
              <button className="rounded border border-zinc-300 px-3 py-1">Sign out</button>
            </form>
          </div>
        </div>
      </header>
      <main className="mx-auto w-full max-w-5xl space-y-8 px-6 py-8">
        <h1 className="text-2xl font-semibold">{title}</h1>
        {children}
      </main>
    </div>
  );
}

export function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="space-y-3 rounded border border-zinc-200 bg-white p-4">
      <h2 className="font-medium">{title}</h2>
      {children}
    </section>
  );
}

export function Message({ kind = "info", children }: { kind?: "info" | "error" | "warning" | "success"; children: ReactNode }) {
  const styles = {
    info: "border-zinc-300 bg-zinc-50 text-zinc-800",
    error: "border-red-300 bg-red-50 text-red-800",
    warning: "border-amber-300 bg-amber-50 text-amber-900",
    success: "border-green-300 bg-green-50 text-green-800",
  }[kind];
  return (
    <p role={kind === "error" ? "alert" : "status"} className={`rounded border px-3 py-2 text-sm ${styles}`}>
      {children}
    </p>
  );
}
