import { Suspense } from "react";
import { Field, Notice, Shell, Submit } from "@/app/_components/ui";

// The stand-in tenant IdP's login page (D11, D22). In production this page belongs to the tenant's own IdP.
type Params = Promise<{ tenantId: string }>;
type SearchParams = Promise<Record<string, string | string[] | undefined>>;

async function IdpForm({ params, searchParams }: { params: Params; searchParams: SearchParams }) {
  const { tenantId } = await params;
  const { error } = await searchParams;
  return (
    <>
      <p className="text-sm text-zinc-600">
        Stand-in identity provider for organization <code>{tenantId}</code>.
      </p>
      {error && <Notice>Sign-in failed. Check your email and password, then try again.</Notice>}
      <form method="post" action={`/mock-idp/${encodeURIComponent(tenantId)}/login`} className="space-y-4">
        <Field label="Email" name="email" type="email" autoComplete="username" />
        <Field label="Password" name="password" type="password" autoComplete="current-password" />
        <Submit>Sign in</Submit>
      </form>
    </>
  );
}

export default function IdpPage({ params, searchParams }: { params: Params; searchParams: SearchParams }) {
  return (
    <Shell title="Organization sign-in">
      <Suspense fallback={null}>
        <IdpForm params={params} searchParams={searchParams} />
      </Suspense>
    </Shell>
  );
}
