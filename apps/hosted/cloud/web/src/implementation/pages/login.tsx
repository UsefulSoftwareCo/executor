import { PasskeyEnrollment } from "../components/passkey-enrollment.tsx";
import { AsyncResult } from "effect/unstable/reactivity";
import { useAtomRefresh, useAtomSet, useAtomValue } from "@effect/atom-react";
import { LoginLegalFooter, LoginPage, loginSearch } from "@executor-js/hosted-web/pages/login";
import { AuthFailed, sessionAtom } from "@executor-js/hosted-web/contracts/auth";
import { Button } from "@executor-js/ui/components/button";
import { Input } from "@executor-js/ui/components/input";
import { Cause, Exit, Option } from "effect";
import { useEffect, useState } from "react";
import {
  finishCloudSignIn,
  passkeySignInAtom,
  sendCodeAtom,
  verifyCodeAtom,
} from "../../contracts/auth.ts";

/** Cloud adds passkeys and verified email codes to the social sign-in choices. */
export function CloudLoginPage(props: ReturnType<typeof loginSearch>) {
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
  return <CloudSignInForm {...props} />;
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

function CloudSignInForm(props: ReturnType<typeof loginSearch>) {
  const send = useAtomSet(sendCodeAtom, { mode: "promiseExit" });
  const verify = useAtomSet(verifyCodeAtom, { mode: "promiseExit" });
  const passkey = useAtomSet(passkeySignInAtom, { mode: "promiseExit" });
  const sending = useAtomValue(sendCodeAtom),
    verifying = useAtomValue(verifyCodeAtom),
    signing = useAtomValue(passkeySignInAtom);
  const [email, setEmail] = useState("");
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pending =
    sending.waiting ||
    verifying.waiting ||
    signing.waiting ||
    AsyncResult.isSuccess(verifying) ||
    AsyncResult.isSuccess(signing);
  const failure = (cause: Cause.Cause<AuthFailed>) => {
    const value = Cause.squash(cause);
    setError(value instanceof AuthFailed ? value.message : "Sign-in failed. Try again.");
  };
  return (
    <LoginPage {...props}>
      <Button
        variant="outline"
        disabled={pending}
        loading={signing.waiting}
        onClick={async () => {
          setError(null);
          const result = await passkey(props.redirect);
          if (Exit.isFailure(result)) failure(result.cause);
        }}
      >
        Sign in with a passkey
      </Button>
      <form
        className="settings-form [&_h2]:text-[15px] [&_h2]:font-medium flex flex-col gap-4 w-full max-w-100 mt-7 [&_label]:flex [&_label]:flex-col [&_label]:gap-1.5 [&_label]:text-[13px]"
        onSubmit={async (event) => {
          event.preventDefault();
          setError(null);
          if (!sent) {
            const result = await send(email.trim());
            if (Exit.isFailure(result)) failure(result.cause);
            else setSent(true);
          } else {
            const otp = String(new FormData(event.currentTarget).get("otp"));
            const result = await verify({ email: email.trim(), otp, redirect: props.redirect });
            if (Exit.isFailure(result)) failure(result.cause);
          }
        }}
      >
        <label>
          Email
          <Input
            type="email"
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
        <Button loading={sending.waiting || verifying.waiting} disabled={pending}>
          {sent ? "Sign in" : "Email me a code"}
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
      <LoginLegalFooter privacyUrl="/privacy" termsUrl="/terms" />
    </LoginPage>
  );
}
