import Link from "next/link";

export default function Home() {
  return (
    <main className="mx-auto w-full max-w-md px-6 py-24">
      <h1 className="text-2xl font-semibold">PayrollHub</h1>
      <p className="mt-2 text-zinc-600">Payroll for HR Admins, Payroll Approvers, and Employees.</p>
      <Link href="/login" className="mt-6 inline-block rounded bg-zinc-900 px-4 py-2 text-white">
        Sign in
      </Link>
    </main>
  );
}
