import { useAtomSet, useAtomValue } from "@effect/atom-react";
import { LoginFrame, LoginLegalFooter, loginSearch } from "@executor-js/hosted-web/pages/login";
import { AuthFailed } from "@executor-js/hosted-web/contracts/auth";
import { Button } from "@executor-js/ui/components/button";
import { Input } from "@executor-js/ui/components/input";
import { HugeiconsIcon } from "@hugeicons/react";
import { ArrowLeft01Icon } from "@hugeicons/core-free-icons";
import { productTitle, useDocumentTitle } from "@executor-js/ui/hooks/document-title";
import { Cause, Exit } from "effect";
import { AsyncResult } from "effect/unstable/reactivity";
import { useState } from "react";
import { ssoSignInAtom } from "../../contracts/sso.ts";

/** Discover the verified company connection from an email, then let its IdP authenticate. */
export function SsoSignInForm({ redirect, error: callbackError }: ReturnType<typeof loginSearch>) {
  useDocumentTitle(productTitle("Sign in with SSO"));
  const [email, setEmail] = useState("");
  const [error, setError] = useState<string>();
  const signIn = useAtomSet(ssoSignInAtom, { mode: "promiseExit" });
  const state = useAtomValue(ssoSignInAtom);
  const pending = state.waiting || AsyncResult.isSuccess(state);
  const message =
    error ?? (callbackError ? "Sign-in could not be completed. Please try again." : undefined);
  return (
    <LoginFrame
      title="Sign in with SSO"
      footer={
        <>
          <a
            className="inline-flex min-h-11 items-center gap-2 rounded-md px-2 text-[13px] transition-colors hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-ring"
            href={`/login?redirect=${encodeURIComponent(redirect)}`}
          >
            <HugeiconsIcon icon={ArrowLeft01Icon} className="size-4" aria-hidden />
            Back to sign in
          </a>
          <LoginLegalFooter privacyUrl="/privacy" termsUrl="/terms" />
        </>
      }
    >
      <p className="mb-6 text-sm leading-6 text-muted-foreground">
        Enter your work email to continue with your company account.
      </p>
      <form
        className="flex flex-col gap-6"
        onSubmit={async (event) => {
          event.preventDefault();
          setError(undefined);
          const result = await signIn({ email, redirect });
          if (Exit.isFailure(result)) {
            const failure = Cause.squash(result.cause);
            setError(
              failure instanceof AuthFailed
                ? failure.message
                : "Unable to start SSO. Please try again.",
            );
          }
        }}
      >
        <label>
          Work email
          <Input
            type="email"
            name="email"
            autoComplete="email"
            autoCapitalize="none"
            spellCheck={false}
            placeholder="you@company.com"
            required
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            disabled={pending}
            aria-describedby={message ? "sso-error" : undefined}
          />
        </label>
        <Button
          type="submit"
          aria-label="Continue with SSO"
          loading={pending}
          disabled={pending}
          className="text-base font-medium"
        >
          Continue with SSO
        </Button>
        {message && (
          <p id="sso-error" role="alert" className="text-[13px] text-destructive">
            {message}
          </p>
        )}
      </form>
    </LoginFrame>
  );
}
