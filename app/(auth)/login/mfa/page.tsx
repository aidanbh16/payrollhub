import { Field, Shell, Submit } from "@/app/_components/ui";

export default function MfaPage() {
  return (
    <Shell title="Enter your authentication code">
      <p className="text-sm text-zinc-600">Open your authenticator app and enter the 6-digit code for PayrollHub.</p>
      <form method="post" action="/api/auth/mfa" className="space-y-4">
        <Field label="Code" name="code" autoComplete="one-time-code" />
        <Submit>Verify</Submit>
      </form>
    </Shell>
  );
}
