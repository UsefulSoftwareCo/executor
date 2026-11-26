import type { AppSignInFailure, AppSignInId } from "@executor-js/local-server/app-ui";
import { Link } from "@tanstack/react-router";
import { useEffect } from "react";

const failureMessage: Record<AppSignInFailure, string> = {
  ended: "This sign-in attempt ended. Open the app URL again.",
  forbidden: "This sign-in request cannot access the app.",
  unavailable: "The app is not deployed or is unavailable.",
};

export function AppSignInPage({
  request,
  failure,
}: {
  readonly request: AppSignInId | undefined;
  readonly failure: AppSignInFailure | undefined;
}) {
  const pending = failure === undefined && request !== undefined;
  useEffect(() => {
    if (pending) window.location.replace(window.location.href);
  }, [pending]);
  return (
    <div className="page setup-page w-full shrink-0 [padding:24px_24px_48px] my-0 mx-auto max-[1000px]:[padding:20px_20px_40px] max-w-212.5 max-[740px]:[padding:18px_max(16px,_env(safe-area-inset-right))_max(32px,_env(safe-area-inset-bottom))_max(16px,_env(safe-area-inset-left))]">
      <h1 className="text-[22px] font-semibold tracking-[-0.035em] leading-[1.35] [&>span]:text-muted-foreground [&>span]:text-[13px] [&>span]:font-mono [&>span]:font-normal [&>span]:ml-[8px] [&>span]:align-middle">
        {pending ? "Opening app…" : "Could not open app"}
      </h1>
      {failure !== undefined && (
        <>
          <p role="alert">{failureMessage[failure]}</p>
          <Link to="/apps">Back to apps</Link>
        </>
      )}
    </div>
  );
}
