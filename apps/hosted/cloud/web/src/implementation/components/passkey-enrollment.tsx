import { LoginFrame } from "@executor-js/hosted-web/pages/login";
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
    <LoginFrame title="Create a passkey">
      <div className="space-y-6 [&>button]:w-full">
        <p className="text-sm text-muted-foreground">
          Sign in faster with your fingerprint, face, or password manager.
        </p>
        <Button
          className="h-10 text-base aria-disabled:cursor-not-allowed aria-disabled:opacity-50"
          aria-label="Create a passkey"
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
        <Button
          data-product-area="auth"
          data-product-action="skip_passkey"
          variant="ghost"
          disabled={adding.waiting}
          onClick={() => dismiss(userId)}
        >
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
      </div>
    </LoginFrame>
  );
}
