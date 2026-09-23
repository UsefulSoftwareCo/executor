import type { DashboardError } from "../../contracts/errors.ts";
import { useAtomSet } from "@effect/atom-react";
import type { AppSignInId } from "@executor-js/local-server/app-ui";
import { Exit, Redacted, type Cause } from "effect";
import { useEffect, useState } from "react";
import { authorizeAppAtom } from "../../contracts/app-ui.ts";
import { Failure } from "../components/common.tsx";
import { Link } from "@tanstack/react-router";

/** Complete a sign-in attempt without mounting dashboard inventory or authored app code. */
export function AppSignInPage({ request }: { readonly request: AppSignInId }) {
  const authorize = useAtomSet(authorizeAppAtom, { mode: "promiseExit" });
  const [error, setError] = useState<Cause.Cause<DashboardError>>();
  useEffect(() => {
    let active = true;
    void authorize({ payload: { request } }).then((exit) => {
      if (!active) return;
      if (Exit.isFailure(exit)) setError(exit.cause);
      else window.location.replace(Redacted.value(exit.value.url));
    });
    return () => {
      active = false;
    };
  }, [request, authorize]);
  return (
    <div className="page setup-page w-full shrink-0 [padding:24px_24px_48px] my-0 mx-auto max-[1000px]:[padding:20px_20px_40px] max-w-212.5 max-[740px]:[padding:18px_max(16px,_env(safe-area-inset-right))_max(32px,_env(safe-area-inset-bottom))_max(16px,_env(safe-area-inset-left))]">
      <h1 className="text-[22px] font-semibold tracking-[-0.035em] leading-[1.35] [&>span]:text-muted-foreground [&>span]:text-[13px] [&>span]:font-mono [&>span]:font-normal [&>span]:ml-[8px] [&>span]:align-middle">
        {error ? "Could not open app" : "Opening app…"}
      </h1>
      {error && (
        <>
          <Failure cause={error} />
          <Link to="/apps">Back to apps</Link>
        </>
      )}
    </div>
  );
}
