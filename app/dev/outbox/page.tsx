import { Field, Shell, Submit } from "@/app/_components/ui";

// The stand-in email provider's webmail (D13): employees read confirmation links and notices here. A mailbox opens
// only with that mailbox's own password, separate from PayrollHub and the IdP (development values in the README).
export default function OutboxPage() {
  return (
    <Shell title="Development mailbox">
      <p className="text-sm text-zinc-600">Stand-in for an employee&apos;s email. Sign in to one mailbox with its mailbox password.</p>
      <form method="post" action="/dev/outbox/view" className="space-y-4">
        <Field label="Email address" name="address" type="email" autoComplete="username" />
        <Field label="Mailbox password" name="password" type="password" autoComplete="current-password" />
        <Submit>Open mailbox</Submit>
      </form>
    </Shell>
  );
}
