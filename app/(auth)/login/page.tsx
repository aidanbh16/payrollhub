import { Suspense } from "react";
import { Field, Notice, Shell, Submit } from "@/app/_components/ui";
import { SIGN_IN_FAILED } from "@/application/auth/messages";

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

const MESSAGES: Record<string, string> = {
  signin: SIGN_IN_FAILED,
  sso: "Single sign-on failed. Start again from your organization's sign-in page.",
};

async function ErrorNotice({ searchParams }: { searchParams: SearchParams }) {
  const { error } = await searchParams;
  const message = typeof error === "string" ? MESSAGES[error] : undefined;
  return message ? <Notice>{message}</Notice> : null;
}

export default function LoginPage({ searchParams }: { searchParams: SearchParams }) {
  return (
    <Shell title="Sign in to PayrollHub">
      <Suspense fallback={null}>
        <ErrorNotice searchParams={searchParams} />
      </Suspense>

      <form method="post" action="/api/auth/login" className="space-y-4">
        <h2 className="font-medium">HR Admins and Payroll Approvers</h2>
        <Field label="Organization id" name="organization" autoComplete="organization" />
        <Field label="Email" name="email" type="email" autoComplete="username" />
        <Field label="Password" name="password" type="password" autoComplete="current-password" />
        <Submit>Continue</Submit>
        <p className="text-sm">
          <a href="/login/unlock" className="underline">
            Locked out after too many attempts?
          </a>
        </p>
      </form>

      <form method="get" action="/api/auth/sso/start" className="space-y-4 border-t border-zinc-200 pt-6">
        <h2 className="font-medium">Employees</h2>
        <Field label="Organization id" name="organization" autoComplete="organization" />
        <Submit>Sign in with your organization</Submit>
      </form>
    </Shell>
  );
}
