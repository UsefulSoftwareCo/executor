/** Visible lifecycle state for a profile. */
import type { Profile } from "@executor-js/sdk";
import type { Atom } from "effect/unstable/reactivity";
import { AsyncResult } from "effect/unstable/reactivity";
import { useAtomSet, useAtomValue } from "@effect/atom-react";
import type { ComponentType } from "react";
import type { FailureProps } from "../../contracts/dashboard.ts";
import { Button } from "../components/button.tsx";
/** Retry preserves the same profile; it never makes another account copy. */
export function ProfileStatus<E>({
  profile,
  retry,
  Failure,
}: {
  readonly profile: Profile;
  readonly retry: Atom.AtomResultFn<void, Profile, E>;
  readonly Failure: ComponentType<FailureProps<E>>;
}) {
  const result = useAtomValue(retry),
    run = useAtomSet(retry);
  const needsAttention =
    profile.status === "failed" || profile.status === "needs-setup" || profile.failure !== null;
  // Account rows and the Tools tab already direct users to fix their selections.
  if (!needsAttention || profile.failure === "accounts") return null;
  const message =
    profile.failure === "cleanup"
      ? "Profile cleanup failed. Retry to finish removing its background work."
      : profile.failure === "configuration"
        ? "Webhook setup needs your attention."
        : "Background setup failed. Retry setup.";
  return (
    <div className="border-t px-4 py-3 text-sm">
      <div className="flex items-center justify-between gap-3">
        <p role="alert">{message}</p>
        <Button
          variant="outline"
          size="sm"
          disabled={AsyncResult.isWaiting(result)}
          onClick={() => run()}
        >
          Retry setup
        </Button>
      </div>
      {AsyncResult.isFailure(result) && <Failure cause={result.cause} />}
    </div>
  );
}
