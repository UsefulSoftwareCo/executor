import * as Sentry from "@sentry/react";
import { useAtomValue } from "@effect/atom-react";
import { sessionAtom } from "@executor-js/hosted-web/contracts/auth";
import { AsyncResult } from "effect/reactivity";
import { useEffect } from "react";

export { startErrorReporting } from "./error-reporting-client.ts";

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

export const reactErrorHandlers = {
  onUncaughtError: reportReactError,
  onCaughtError: reportReactError,
  onRecoverableError: reportReactError,
};
