import { Suspense } from "react";
import { Field, Shell, Submit } from "@/app/_components/ui";
import { OpenUnlockLink } from "./open-unlock-link";

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

// Unlock sign-in (RT-04, D46). Asking sends a link to the staff member's own mailbox, and the answer never says
// whether the account exists. Opening the link here gives THIS browser a fresh sign-in budget; the password and the
// authenticator code are still required. The link's token is in the URL fragment, which is never sent to a server.

async function Sent({ searchParams }: { searchParams: SearchParams }) {
  const { sent } = await searchParams;
  return sent === "1" ? (
    <p role="status" className="rounded border border-zinc-300 bg-zinc-50 px-3 py-2 text-sm">
      If that is a staff account, an unlock link is on its way to its mailbox. Open it in the browser you want to sign
      in with.
    </p>
  ) : null;
}

export default function UnlockPage({ searchParams }: { searchParams: SearchParams }) {
  return (
    <Shell title="Unlock sign-in">
      <Suspense fallback={null}>
        <Sent searchParams={searchParams} />
      </Suspense>
      <OpenUnlockLink />
      <form method="post" action="/api/auth/unlock" className="space-y-4">
        <p className="text-sm text-zinc-700">
          Too many sign-in attempts on your account from new browsers? Ask for an unlock link, sent to your own mailbox.
        </p>
        <Field label="Organization id" name="organization" autoComplete="organization" />
        <Field label="Email" name="email" type="email" autoComplete="username" />
        <Submit>Send an unlock link</Submit>
      </form>
      <p className="text-sm">
        <a href="/login" className="underline">
          Back to sign in
        </a>
      </p>
    </Shell>
  );
}
