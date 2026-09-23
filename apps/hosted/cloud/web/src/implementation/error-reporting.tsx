/** Cloud browser error reporting with explicit deployment identity and no session replay. */
import * as Sentry from "@sentry/react";
import { useAtomValue } from "@effect/atom-react";
import { sessionAtom } from "@executor-js/hosted-web/contracts/auth";
import { AsyncResult } from "effect/unstable/reactivity";
import { useEffect } from "react";

export { startErrorReporting } from "./error-reporting-client.ts";

/** Keep Sentry's user context aligned with confirmed sign-in and sign-out state. */
export function ErrorReportingIdentity() {
  const session = useAtomValue(sessionAtom);
  useEffect(() => {
    if (AsyncResult.isSuccess(session) && !session.waiting)
      Sentry.setUser(session.value ? { id: session.value.user.id } : null);
  }, [session]);
  return null;
}

const reportReactError = (error: unknown, info: { componentStack?: string | undefined }) =>
  Sentry.reactErrorHandler()(
    error,
    info.componentStack === undefined ? {} : { componentStack: info.componentStack },
  );

/** React 19 forwards caught and uncaught failures; normalize its optional stack at the SDK boundary. */
export const reactErrorHandlers = {
  onUncaughtError: reportReactError,
  onCaughtError: reportReactError,
  onRecoverableError: reportReactError,
};
