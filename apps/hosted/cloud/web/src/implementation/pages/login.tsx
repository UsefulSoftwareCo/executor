import { PasskeyEnrollment } from "../components/passkey-enrollment.tsx";
import { reportBrowserUsage } from "@executor-js/hosted-web/contracts/product-analytics";
import { AsyncResult } from "effect/unstable/reactivity";
import { useAtomRefresh, useAtomSet, useAtomValue } from "@effect/atom-react";
import { LoginLegalFooter, LoginPage, loginSearch } from "@executor-js/hosted-web/pages/login";
import { AuthFailed, sessionAtom } from "@executor-js/hosted-web/contracts/auth";
import { Button } from "@executor-js/ui/components/button";
import { Input } from "@executor-js/ui/components/input";
import { Cause, Exit, Option } from "effect";
import { useEffect, useState } from "react";
import { SsoSignInForm } from "./sso-sign-in.tsx";
import { Spinner } from "@executor-js/ui/components/spinner";
import {
  finishCloudSignIn,
  passkeySignInAtom,
  beginEmailSignInAtom,
  verifyCodeAtom,
} from "../../contracts/auth.ts";

/** Cloud adds passkeys and verified email codes to the social sign-in choices. */
export function CloudLoginPage(
  props: ReturnType<typeof loginSearch> & {
    readonly method?: "sso";
    readonly mode?: "signin" | "signup";
  },
) {
  const session = useAtomValue(sessionAtom);
  const refresh = useAtomRefresh(sessionAtom);
  const current = Option.getOrUndefined(AsyncResult.value(session));
  const verified = AsyncResult.isSuccess(session) && !session.waiting && session.value !== null;
  // This is the displayed flow's identity, never session authority or a credential cache.
  const [enrollmentUser, setEnrollmentUser] = useState<string>();
  if (verified && enrollmentUser !== session.value.user.id)
    setEnrollmentUser(session.value.user.id);
  else if (current === null && enrollmentUser !== undefined) setEnrollmentUser(undefined);
  if (current && (verified || enrollmentUser === current.user.id))
    return (
      <>
        <PasskeyEnrollment key={current.user.id} userId={current.user.id} canSubmit={verified}>
          <CompleteSignIn redirect={props.redirect} verified={verified} />
        </PasskeyEnrollment>
        {AsyncResult.isFailure(session) && (
          <div
            role="alert"
            className="fixed bottom-4 left-1/2 flex -translate-x-1/2 items-center gap-3 rounded-lg border bg-background p-3 text-sm"
          >
            <p>Unable to check your session.</p>
            <Button variant="outline" onClick={refresh}>
              Try again
            </Button>
          </div>
        )}
      </>
    );
  if (AsyncResult.isFailure(session) && current !== null)
    return (
      <div
        className="min-h-dvh flex items-center justify-center gap-4 bg-background text-foreground"
        role="alert"
      >
        <p>Unable to check your session.</p>
        <Button variant="outline" onClick={refresh}>
          Try again
        </Button>
      </div>
    );
  if (current === undefined)
    return (
      <div className="min-h-dvh flex items-center justify-center bg-background text-foreground">
        <Spinner />
      </div>
    );
  return props.method === "sso" ? <SsoSignInForm {...props} /> : <CloudSignInForm {...props} />;
}

function CompleteSignIn({
  redirect,
  verified,
}: {
  readonly redirect: string;
  readonly verified: boolean;
}) {
  useEffect(() => {
    if (verified) finishCloudSignIn(redirect);
  }, [redirect, verified]);
  return null;
}

function CloudSignInForm(
  props: ReturnType<typeof loginSearch> & { readonly mode?: "signin" | "signup" },
) {
  const signingUp = props.mode === "signup";
  const begin = useAtomSet(beginEmailSignInAtom, { mode: "promiseExit" });
  const verify = useAtomSet(verifyCodeAtom, { mode: "promiseExit" });
  const passkey = useAtomSet(passkeySignInAtom, { mode: "promiseExit" });
  const beginning = useAtomValue(beginEmailSignInAtom),
    verifying = useAtomValue(verifyCodeAtom),
    signing = useAtomValue(passkeySignInAtom);
  const [email, setEmail] = useState("");
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const redirecting = AsyncResult.isSuccess(beginning) && beginning.value === "sso";
  const pending =
    beginning.waiting ||
    redirecting ||
    verifying.waiting ||
    signing.waiting ||
    AsyncResult.isSuccess(verifying) ||
    AsyncResult.isSuccess(signing);
  const failure = (cause: Cause.Cause<AuthFailed>) => {
    reportBrowserUsage({ area: "auth", action: "sign_in", outcome: "failure" });
    const value = Cause.squash(cause);
    setError(value instanceof AuthFailed ? value.message : "Sign-in failed. Try again.");
  };
  return (
    <LoginPage
      {...props}
      title={signingUp ? "Sign up" : "Sign in"}
      cardFooter={
        <p className="text-center text-sm text-muted-foreground">
          {signingUp ? "Already have an account? " : "Don't have an account? "}
          <a
            className="text-foreground hover:underline underline-offset-4"
            href={`/login?mode=${signingUp ? "signin" : "signup"}&redirect=${encodeURIComponent(props.redirect)}`}
          >
            {signingUp ? "Sign in" : "Sign up"}
          </a>
        </p>
      }
      footer={
        <>
          <div className="flex justify-center">
            <Button
              variant="link"
              className="h-auto p-0 text-[13px] text-muted-foreground hover:text-foreground"
              aria-label="Sign in with a passkey"
              disabled={pending}
              loading={signing.waiting}
              onClick={async () => {
                setError(null);
                reportBrowserUsage({ area: "auth", action: "passkey", outcome: "started" });
                const result = await passkey(props.redirect);
                if (Exit.isSuccess(result))
                  reportBrowserUsage({ area: "auth", action: "passkey", outcome: "success" });
                if (Exit.isFailure(result)) failure(result.cause);
              }}
            >
              Sign in with a passkey
            </Button>
          </div>
          <LoginLegalFooter privacyUrl="/privacy" termsUrl="/terms" />
        </>
      }
    >
      <form
        className="settings-form"
        onSubmit={async (event) => {
          event.preventDefault();
          setError(null);
          if (!sent) {
            reportBrowserUsage({ area: "auth", action: "email_sign_in", outcome: "started" });
            const result = await begin({ email: email.trim(), redirect: props.redirect });
            reportBrowserUsage({
              area: "auth",
              action: "email_sign_in",
              outcome: Exit.isSuccess(result) ? "success" : "failure",
            });
            if (Exit.isFailure(result)) failure(result.cause);
            else if (result.value === "email-code") setSent(true);
          } else {
            reportBrowserUsage({ area: "auth", action: "verify_email_code", outcome: "started" });
            const otp = String(new FormData(event.currentTarget).get("otp"));
            const result = await verify({ email: email.trim(), otp, redirect: props.redirect });
            reportBrowserUsage({
              area: "auth",
              action: "verify_email_code",
              outcome: Exit.isSuccess(result) ? "success" : "failure",
            });
            if (Exit.isFailure(result)) failure(result.cause);
          }
        }}
      >
        <label>
          Email
          <Input
            type="email"
            placeholder="Your email address"
            required
            autoComplete="email"
            value={email}
            disabled={pending || sent}
            onChange={(event) => setEmail(event.target.value)}
          />
        </label>
        {sent && (
          <>
            <p>Enter the code sent to {email}. It expires in five minutes.</p>
            <label>
              Sign-in code
              <Input
                name="otp"
                inputMode="numeric"
                autoComplete="one-time-code"
                required
                pattern="[0-9]{6}"
                minLength={6}
                maxLength={6}
                autoFocus
              />
            </label>
          </>
        )}
        <Button
          aria-label={sent ? "Sign in" : "Continue"}
          className="text-base font-medium"
          loading={beginning.waiting || verifying.waiting || redirecting}
          disabled={pending}
        >
          {sent ? "Sign in" : "Continue"}
        </Button>
        {sent && (
          <Button
            type="button"
            variant="ghost"
            disabled={pending}
            onClick={() => {
              setSent(false);
              setError(null);
            }}
          >
            Use another email or send a new code
          </Button>
        )}
      </form>
      {error && (
        <p className="auth-error text-destructive text-[13px]" role="alert">
          {error}
        </p>
      )}
    </LoginPage>
  );
}
