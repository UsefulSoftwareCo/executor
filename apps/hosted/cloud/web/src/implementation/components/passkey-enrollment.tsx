import { useAtomSet, useAtomValue } from "@effect/atom-react";
import { Button } from "@executor-js/ui/components/button";
import { Exit } from "effect";
import { AsyncResult } from "effect/unstable/reactivity";
import { useState, type ReactNode } from "react";
import { addPasskeyAtom } from "../../contracts/auth.ts";
import {
  dismissPasskeyEnrollmentAtom,
  hasPasskeyEnrollment,
  passkeyEnrollmentAtom,
} from "../../contracts/passkey-enrollment.ts";

/** Optional enrollment after sign-in. Dashboard routes never mount or query this flow. */
export function PasskeyEnrollment({
  userId,
  children,
  canSubmit = true,
}: {
  readonly userId: string;
  readonly children: ReactNode;
  readonly canSubmit?: boolean;
}) {
  if (!hasPasskeyEnrollment(userId)) return children;
  return (
    <Enrollment key={userId} userId={userId} canSubmit={canSubmit}>
      {children}
    </Enrollment>
  );
}

function Enrollment({
  userId,
  children,
  canSubmit,
}: {
  readonly userId: string;
  readonly children: ReactNode;
  readonly canSubmit: boolean;
}) {
  const enrollment = useAtomValue(passkeyEnrollmentAtom(userId));
  const add = useAtomSet(addPasskeyAtom, { mode: "promiseExit" });
  const dismiss = useAtomSet(dismissPasskeyEnrollmentAtom, { mode: "promiseExit" });
  const adding = useAtomValue(addPasskeyAtom);
  const [error, setError] = useState<string | null>(null);
  if (AsyncResult.isSuccess(enrollment) && !enrollment.value) return children;
  const checking = AsyncResult.isInitial(enrollment);
  return (
    <main className="auth-page flex flex-col min-h-dvh items-center justify-center p-[24px]">
      <section className="auth-form w-full max-w-85 flex flex-col gap-6 [&_form]:flex [&_form]:flex-col [&_form]:gap-4 [&_label]:flex [&_label]:flex-col [&_label]:gap-1.75 [&_label]:text-[13px] [&_label]:font-medium [&_input]:h-10.5 [&_form_>_button]:min-h-10.5 [&_.wordmark]:p-0 [&_.wordmark]:h-8 [&_.wordmark]:min-h-8 [&_.wordmark]:w-auto [&_.wordmark]:justify-start">
        <div className="wordmark flex items-center gap-2 h-12 py-0 px-[8px] font-mono text-[15px] font-medium [&_img]:w-5.25 [&_img]:h-5.25 max-[740px]:p-0 max-[740px]:w-11 max-[740px]:h-11 max-[740px]:justify-center max-[740px]:shrink-0 max-[740px]:[&_>_span]:hidden">
          <img src="/favicon.png" alt="" />
          executor
        </div>
        <h1 className="text-[22px] font-semibold tracking-[-0.035em] leading-[1.35] [&>span]:text-muted-foreground [&>span]:text-[13px] [&>span]:font-mono [&>span]:font-normal [&>span]:ml-[8px] [&>span]:align-middle">
          Create a passkey
        </h1>
        <p>Sign in faster with your fingerprint, face, or password manager.</p>
        <Button
          className="aria-disabled:cursor-not-allowed aria-disabled:opacity-50"
          loading={adding.waiting || checking}
          aria-disabled={!canSubmit || checking || AsyncResult.isFailure(enrollment) || undefined}
          onClick={async () => {
            if (!canSubmit || checking || AsyncResult.isFailure(enrollment)) return;
            setError(null);
            const result = await add("Passkey");
            if (Exit.isFailure(result))
              setError("Passkey was not added. Try again or choose Not now to continue.");
            else await dismiss(userId);
          }}
        >
          Create a passkey
        </Button>
        <Button variant="ghost" disabled={adding.waiting} onClick={() => dismiss(userId)}>
          Not now
        </Button>
        {AsyncResult.isFailure(enrollment) && (
          <p className="auth-error text-destructive text-[13px]" role="alert">
            Unable to check your passkeys. Choose Not now to continue.
          </p>
        )}
        {error && (
          <p className="auth-error text-destructive text-[13px]" role="alert">
            {error}
          </p>
        )}
      </section>
    </main>
  );
}
