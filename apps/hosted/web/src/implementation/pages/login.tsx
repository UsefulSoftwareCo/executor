import { ContinueAfterSignIn } from "../components/sign-in.tsx";
export { ContinueAfterSignIn } from "../components/sign-in.tsx";
import { browserReturnTo } from "@executor-js/hosted-server/browser/contracts";
import { AsyncResult } from "effect/unstable/reactivity";
import { useAtomRefresh, useAtomSet, useAtomValue } from "@effect/atom-react";
import { Cause, Exit, Option } from "effect";
import { useState, type ReactNode } from "react";
import { AuthFailed, sessionAtom, signInAtom } from "../../contracts/auth.ts";
import { Button } from "@executor-js/ui/components/button";
import { Spinner } from "@executor-js/ui/components/spinner";
import { productTitle, useDocumentTitle } from "@executor-js/ui/hooks/document-title";

const callbackError = (error: unknown): string | null => {
  if (typeof error !== "string" || error === "") return null;
  if (error === "access_denied") return "Sign-in was canceled. You can try again.";
  if (error === "account_not_linked" || error === "unable_to_link_account")
    return "This email is not linked to this sign-in method. Contact an administrator.";
  return "Sign-in could not be completed. Please try again.";
};

/** Preserve internal return paths and render only known, safe OAuth error messages. */
export const loginSearch = (
  search: Record<string, unknown>,
): { redirect: string; error?: string } => {
  const error =
    typeof search.error === "string" && search.error !== "" ? { error: search.error } : {};
  return { redirect: browserReturnTo(search.redirect), ...error };
};

function GoogleIcon() {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden>
      <path
        fill="#4285F4"
        d="M21.6 12.23c0-.71-.06-1.39-.18-2.05H12v3.88h5.38a4.6 4.6 0 0 1-2 3.02v2.51h3.24c1.9-1.75 2.98-4.33 2.98-7.36Z"
      />
      <path
        fill="#34A853"
        d="M12 22c2.7 0 4.96-.9 6.62-2.41l-3.24-2.51c-.9.6-2.05.97-3.38.97-2.6 0-4.82-1.76-5.61-4.13H3.04v2.59A10 10 0 0 0 12 22Z"
      />
      <path
        fill="#FBBC05"
        d="M6.39 13.92a6 6 0 0 1 0-3.84V7.49H3.04a10 10 0 0 0 0 9.02l3.35-2.59Z"
      />
      <path
        fill="#EA4335"
        d="M12 5.95c1.47 0 2.79.51 3.83 1.51l2.87-2.87A9.62 9.62 0 0 0 12 2a10 10 0 0 0-8.96 5.49l3.35 2.59A5.99 5.99 0 0 1 12 5.95Z"
      />
    </svg>
  );
}

function GitHubIcon() {
  return (
    <svg viewBox="0 0 1024 1024" className="size-4" aria-hidden>
      <path
        fill="currentColor"
        fillRule="evenodd"
        clipRule="evenodd"
        d="M512 0C229.12 0 0 229.12 0 512c0 226.56 146.56 417.92 350.08 485.76 25.6 4.48 35.2-10.88 35.2-24.32 0-12.16-.64-52.48-.64-95.36-128.64 23.68-161.92-31.36-172.16-60.16-5.76-14.72-30.72-60.16-52.48-72.32-17.92-9.6-43.52-33.28-.64-33.92 40.32-.64 69.12 37.12 78.72 52.48 46.08 77.44 119.68 55.68 149.12 42.24 4.48-33.28 17.92-55.68 32.64-68.48-113.92-12.8-232.96-56.96-232.96-252.8 0-55.68 19.84-101.76 52.48-137.6-5.12-12.8-23.04-65.28 5.12-135.68 0 0 42.88-13.44 140.8 52.48 40.96-11.52 84.48-17.28 128-17.28s87.04 5.76 128 17.28c97.92-66.56 140.8-52.48 140.8-52.48 28.16 70.4 10.24 122.88 5.12 135.68 32.64 35.84 52.48 81.28 52.48 137.6 0 196.48-119.68 240-233.6 252.8 18.56 16 34.56 46.72 34.56 94.72 0 68.48-.64 123.52-.64 140.8 0 13.44 9.6 29.44 35.2 24.32C877.44 929.92 1024 737.92 1024 512 1024 229.12 794.88 0 512 0"
      />
    </svg>
  );
}

/** Shared themed card for Cloud sign-in, SSO, and credential enrollment. */
export function LoginFrame({
  title,
  children,
  footer,
}: {
  readonly title: string;
  readonly children: ReactNode;
  readonly footer?: ReactNode;
}) {
  return (
    <main className="auth-page flex min-h-dvh flex-col items-center justify-center bg-background px-4 py-12 text-foreground">
      <div className="w-full max-w-110">
        <h1 className="mb-6 text-center text-2xl font-semibold leading-8 tracking-tight">
          {title}
        </h1>
        <section className="auth-form rounded-2xl border border-border bg-muted/50 p-12 max-[520px]:p-6 [&_form]:flex [&_form]:flex-col [&_form]:gap-6 [&_label]:flex [&_label]:flex-col [&_label]:gap-2 [&_label]:text-sm [&_label]:font-semibold [&_input]:h-10 [&_input]:bg-background [&_input]:text-base [&_input]:font-normal [&_input]:shadow-none [&_input]:placeholder:text-muted-foreground [&_form_>_button]:min-h-10">
          {children}
        </section>
        {footer && (
          <div className="mt-5 flex flex-col items-center gap-4 text-sm text-muted-foreground [&_.auth-legal]:mt-0">
            {footer}
          </div>
        )}
      </div>
    </main>
  );
}

/** Cloud social sign-in, composed with additional cloud credentials. */
export function LoginPage({
  redirect,
  error: callbackCode,
  children,
  title = "Sign in",
  cardFooter,
  footer,
}: ReturnType<typeof loginSearch> & {
  readonly children?: ReactNode;
  readonly title?: string;
  readonly cardFooter?: ReactNode;
  readonly footer?: ReactNode;
}) {
  useDocumentTitle(productTitle(title));
  const callbackFailure = callbackError(callbackCode);
  const session = useAtomValue(sessionAtom);
  const refreshSession = useAtomRefresh(sessionAtom);
  const signIn = useAtomSet(signInAtom, { mode: "promiseExit" });
  const state = useAtomValue(signInAtom);
  const [error, setError] = useState<string | null>(null);
  const [provider, setProvider] = useState<"google" | "github" | null>(null);
  const lastSession = AsyncResult.value(session);
  // Keep child form fields mounted during revalidation of a signed-out session.
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
  if (signedIn) return <ContinueAfterSignIn redirect={redirect} userId={session.value.user.id} />;
  if ((session.waiting && !signedOut) || AsyncResult.isInitial(session))
    return (
      <div className="auth-pending min-h-dvh flex items-center justify-center gap-4">
        <Spinner />
      </div>
    );
  const start = async (provider: "google" | "github") => {
    setError(null);
    setProvider(provider);
    const result = await signIn({ provider, redirect });
    if (Exit.isFailure(result)) {
      const error = Cause.squash(result.cause);
      setError(error instanceof AuthFailed ? error.message : "Unable to start sign-in. Try again.");
      setProvider(null);
    }
  };
  return (
    <LoginFrame title={title} footer={footer}>
      <div className="space-y-6">
        {children}
        <div className="flex items-center gap-3 text-xs text-muted-foreground" aria-hidden="true">
          <span className="h-px flex-1 bg-border" />
          OR
          <span className="h-px flex-1 bg-border" />
        </div>
        <div className="social-login flex flex-col gap-3 [&_[data-slot=button]]:h-10 [&_[data-slot=button]]:gap-3 [&_[data-slot=button]]:text-base [&_[data-slot=button]]:font-medium [&_[data-slot=button]]:shadow-none">
          <Button
            variant="outline"
            aria-label="Continue with Google"
            disabled={state.waiting}
            loading={state.waiting && provider === "google"}
            onClick={() => start("google")}
          >
            <GoogleIcon />
            Continue with Google
          </Button>
          <Button
            variant="outline"
            aria-label="Continue with GitHub"
            disabled={state.waiting}
            loading={state.waiting && provider === "github"}
            onClick={() => start("github")}
          >
            <GitHubIcon />
            Continue with GitHub
          </Button>
        </div>
        {AsyncResult.isFailure(session) && (
          <div role="alert" className="space-y-3 text-sm text-destructive">
            <p>Unable to check your session.</p>
            <Button type="button" variant="outline" onClick={refreshSession}>
              Try again
            </Button>
          </div>
        )}
        {(error || callbackFailure) && (
          <p className="auth-error text-destructive text-[13px]" role="alert">
            {error || callbackFailure}
          </p>
        )}
        {cardFooter}
      </div>
    </LoginFrame>
  );
}

/** Product hosts provide their own legal URLs because cloud and self-host differ. */
export function LoginLegalFooter({
  privacyUrl,
  termsUrl,
}: {
  readonly privacyUrl: string;
  readonly termsUrl: string;
}) {
  return (
    <p className="auth-legal mt-4 flex items-center justify-center gap-2 text-xs text-muted-foreground">
      <a href={privacyUrl}>Privacy</a>
      <span aria-hidden>·</span>
      <a href={termsUrl}>Terms</a>
    </p>
  );
}
