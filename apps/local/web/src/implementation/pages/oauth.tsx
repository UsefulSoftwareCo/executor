import { AsyncResult } from "effect/unstable/reactivity";
import { useAtomValue } from "@effect/atom-react";
import { Effect } from "effect";
import { useEffect } from "react";
import { completeOAuthAtom } from "../../contracts/oauth.ts";
import { oauthDestination } from "../oauth.ts";
import { Link, useNavigate } from "@tanstack/react-router";
import { Empty, Failure } from "../components/common.tsx";

/** The provider returns here; authenticated Atom calls complete the saved sign-in. */
export function OAuthCallbackPage() {
  const navigate = useNavigate();
  const result = useAtomValue(completeOAuthAtom);
  useEffect(() => {
    if (!AsyncResult.isSuccess(result) || result.value === undefined) return;
    void navigate(Effect.runSync(oauthDestination(result.value.id)));
  }, [result, navigate]);
  return (
    <div className="page setup-page w-full shrink-0 [padding:24px_24px_48px] my-0 mx-auto max-[1000px]:[padding:20px_20px_40px] max-w-212.5 max-[740px]:[padding:18px_max(16px,_env(safe-area-inset-right))_max(32px,_env(safe-area-inset-bottom))_max(16px,_env(safe-area-inset-left))]">
      {AsyncResult.isFailure(result) ? (
        <>
          <Failure cause={result.cause} />
          <Link to="/accounts">Return to Accounts</Link>
        </>
      ) : AsyncResult.isSuccess(result) && result.value === undefined ? (
        <Empty title="This sign-in has ended">
          <Link to="/accounts">Open Accounts</Link>
        </Empty>
      ) : (
        <Empty title="Connecting your account">Completing provider sign-in…</Empty>
      )}
    </div>
  );
}
