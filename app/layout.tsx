import type { Metadata } from "next";
import { connection } from "next/server";
import type { ReactNode } from "react";
import "./globals.css";

export const metadata: Metadata = {
  title: "PayrollHub",
  description: "Multi-tenant payroll platform",
  referrer: "no-referrer",
};

// Every page renders per request (connection()), so Next.js can put this request's CSP nonce on its scripts. Nothing
// is prerendered or cached; Proxy sends Cache-Control: no-store on every page.
export default async function RootLayout({ children }: { children: ReactNode }) {
  await connection();
  return (
    <html lang="en" className="h-full antialiased">
      <body className="min-h-full flex flex-col bg-zinc-50 text-zinc-900">{children}</body>
    </html>
  );
}
