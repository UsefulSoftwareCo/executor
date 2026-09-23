import { useAtomRefresh, useAtomSet, useAtomValue } from "@effect/atom-react";
import { AuthFailed, sessionAtom } from "@executor-js/hosted-web/contracts/auth";
import {
  ContinueAfterSignIn,
  LoginLegalFooter,
  loginSearch,
} from "@executor-js/hosted-web/pages/login";
import { Button } from "@executor-js/ui/components/button";
import { Input } from "@executor-js/ui/components/input";
import { Spinner } from "@executor-js/ui/components/spinner";
import { Cause, Exit, Option } from "effect";
import { AsyncResult } from "effect/unstable/reactivity";
import { useState } from "react";
import {
  configurationAtom,
  selfHostSignInAtom,
  type SelfHostSignIn,
} from "../../contracts/auth.ts";
import { productTitle, useDocumentTitle } from "@executor-js/ui/hooks/document-title";

/** Password login and first-run setup; only an operator-configured SSO button is shown. */
export function SelfHostLoginPage({
  redirect,
  error: callbackError,
}: ReturnType<typeof loginSearch>) {
  useDocumentTitle(productTitle("Sign in"));
  const config = useAtomValue(configurationAtom);
  const session = useAtomValue(sessionAtom);
  const refreshSession = useAtomRefresh(sessionAtom);
  const pending = useAtomValue(selfHostSignInAtom);
  const submit = useAtomSet(selfHostSignInAtom, { mode: "promiseExit" });
  const [error, setError] = useState<string | null>(null);
  const [joining, setJoining] = useState(false);
  const [submittedKind, setSubmittedKind] = useState<SelfHostSignIn["kind"] | null>(null);
  const lastSession = AsyncResult.value(session);
  // A background check must not unmount a form shown after confirmed sign-out.
  const signedOut = Option.isSome(lastSession) && lastSession.value === null;
  const signedIn = AsyncResult.isSuccess(session) && !session.waiting && session.value !== null;
  if (AsyncResult.isFailure(session) && !signedOut)
    return (
      <div className="auth-pending min-h-dvh flex items-center justify-center gap-4">
        <p>Unable to check your session.</p>
        <Button variant="outline" onClick={refreshSession}>
          Try again
        </Button>
      </div>
    );
  if (signedIn)
    return (
      <ContinueAfterSignIn
        redirect={
          submittedKind === "setup" &&
          new URL(redirect, window.location.origin).pathname !== "/mcp/authorize"
            ? "/setup/agent"
            : submittedKind === "invite"
              ? "/"
              : redirect
        }
        userId={session.value.user.id}
      />
    );
  if (
    (session.waiting && !signedOut) ||
    AsyncResult.isInitial(session) ||
    AsyncResult.isInitial(config)
  )
    return (
      <div className="auth-pending min-h-dvh flex items-center justify-center gap-4">
        <Spinner />
      </div>
    );
  if (AsyncResult.isFailure(config))
    return (
      <main className="auth-page flex flex-col min-h-dvh items-center justify-center p-[24px]">
        <p role="alert">Unable to load sign-in settings. Reload to try again.</p>
      </main>
    );
  const invitation = new URL(redirect, location.origin).searchParams.get("invitation");
  const setup = config.value.setup;
  const registration = setup || (joining && invitation !== null);
  const complete = async (input: SelfHostSignIn) => {
    setError(null);
    // Select the destination before the successful write refreshes the session.
    setSubmittedKind(input.kind);
    const result = await submit(input);
    if (Exit.isFailure(result)) {
      const failure = Cause.squash(result.cause);
      setError(
        failure instanceof AuthFailed
          ? failure.message
          : "Sign-in could not be completed. Try again.",
      );
    }
  };
  return (
    <main className="auth-page flex flex-col min-h-dvh items-center justify-center p-[24px]">
      <section className="auth-form w-full max-w-85 flex flex-col gap-6 [&_form]:flex [&_form]:flex-col [&_form]:gap-4 [&_label]:flex [&_label]:flex-col [&_label]:gap-1.75 [&_label]:text-[13px] [&_label]:font-medium [&_input]:h-10.5 [&_form_>_button]:min-h-10.5 [&_.wordmark]:p-0 [&_.wordmark]:h-8 [&_.wordmark]:min-h-8 [&_.wordmark]:w-auto [&_.wordmark]:justify-start">
        <div className="wordmark flex items-center gap-2 h-12 py-0 px-[8px] font-mono text-[15px] font-medium [&_img]:w-5.25 [&_img]:h-5.25 max-[740px]:p-0 max-[740px]:w-11 max-[740px]:h-11 max-[740px]:justify-center max-[740px]:shrink-0 max-[740px]:[&_>_span]:hidden">
          <img src="/favicon.png" alt="" />
          executor
        </div>
        <h1 className="text-[22px] font-semibold tracking-[-0.035em] leading-[1.35] [&>span]:text-muted-foreground [&>span]:text-[13px] [&>span]:font-mono [&>span]:font-normal [&>span]:ml-[8px] [&>span]:align-middle">
          {setup ? "Set up Executor" : registration ? "Join Executor" : "Sign in to Executor"}
        </h1>
        {setup && <p>Create your administrator account and organization.</p>}
        <form
          className="settings-form [&_h2]:text-[15px] [&_h2]:font-medium flex flex-col gap-4 w-full max-w-100 mt-7 [&_label]:flex [&_label]:flex-col [&_label]:gap-1.5 [&_label]:text-[13px]"
          onSubmit={async (event) => {
            event.preventDefault();
            const data = new FormData(event.currentTarget);
            const email = String(data.get("email")).trim(),
              password = String(data.get("password")),
              name = String(data.get("name")).trim();
            if (setup)
              await complete({
                kind: "setup",
                name,
                email,
                password,
                organizationName: String(data.get("organizationName")).trim(),
              });
            else if (joining && invitation)
              await complete({ kind: "invite", name, email, password, invitation });
            else await complete({ kind: "login", email, password });
          }}
        >
          {setup && (
            <label>
              Organization name
              <Input name="organizationName" required maxLength={100} autoComplete="organization" />
            </label>
          )}
          {registration && (
            <label>
              Your name
              <Input name="name" required maxLength={100} autoComplete="name" />
            </label>
          )}
          <label>
            Email
            <Input name="email" type="email" required autoComplete="email" />
          </label>
          <label>
            Password
            <Input
              name="password"
              type="password"
              required
              minLength={registration ? 8 : undefined}
              maxLength={128}
              autoComplete={registration ? "new-password" : "current-password"}
            />
          </label>
          <Button loading={pending.waiting}>
            {setup
              ? "Create administrator account"
              : registration
                ? "Accept invitation"
                : "Sign in"}
          </Button>
        </form>
        {!setup && invitation && (
          <Button variant="ghost" disabled={pending.waiting} onClick={() => setJoining(!joining)}>
            {joining ? "Back to sign in" : "Join with this invitation"}
          </Button>
        )}
        {!setup && config.value.sso && (
          <Button
            variant="outline"
            disabled={pending.waiting}
            onClick={() => complete({ kind: "sso", redirect })}
          >
            Continue with SSO
          </Button>
        )}
        {(error || callbackError) && (
          <p className="auth-error text-destructive text-[13px]" role="alert">
            {error ?? "SSO sign-in failed. Use an approved account or contact your administrator."}
          </p>
        )}
        {AsyncResult.isFailure(session) && (
          <div role="alert" className="space-y-3 text-sm text-destructive">
            <p>Unable to check your session.</p>
            <Button type="button" variant="outline" onClick={refreshSession}>
              Try again
            </Button>
          </div>
        )}
        <LoginLegalFooter
          privacyUrl="https://executor.sh/privacy"
          termsUrl="https://executor.sh/terms"
        />
      </section>
    </main>
  );
}
