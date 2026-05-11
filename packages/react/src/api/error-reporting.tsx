import * as React from "react";
import * as Cause from "effect/Cause";
import * as Data from "effect/Data";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

export type FrontendErrorContext = {
  readonly surface: string;
  readonly action: string;
  readonly message?: string;
  readonly severity?: "error" | "warning";
  readonly metadata?: Record<string, string | number | boolean | null | undefined>;
};

export type FrontendErrorReporter = (error: unknown, context: FrontendErrorContext) => void;

class FrontendHandledError extends Data.TaggedError("FrontendHandledError")<{
  readonly cause: unknown;
  readonly context: FrontendErrorContext;
}> {}

const ErrorMessage = Schema.Struct({ message: Schema.String });
const decodeErrorMessage = Schema.decodeUnknownOption(ErrorMessage);

const defaultFrontendErrorReporter: FrontendErrorReporter = (error, context) => {
  if (typeof globalThis.reportError !== "function") return;
  globalThis.reportError(new FrontendHandledError({ cause: error, context }));
};

const FrontendErrorReporterContext = React.createContext<FrontendErrorReporter>(
  defaultFrontendErrorReporter,
);

let currentFrontendErrorReporter = defaultFrontendErrorReporter;

export const reportHandledFrontendError = (error: unknown, context: FrontendErrorContext): void => {
  currentFrontendErrorReporter(error, context);
};

export const FrontendErrorReporterProvider = (
  props: React.PropsWithChildren<{ reporter?: FrontendErrorReporter }>,
) => {
  const reporter = props.reporter ?? defaultFrontendErrorReporter;
  currentFrontendErrorReporter = reporter;
  return (
    <FrontendErrorReporterContext.Provider value={reporter}>
      {props.children}
    </FrontendErrorReporterContext.Provider>
  );
};

export const useReportHandledError = (): FrontendErrorReporter =>
  React.useContext(FrontendErrorReporterContext);

export const messageFromUnknown = (error: unknown, fallback: string): string =>
  Option.match(decodeErrorMessage(error), {
    onNone: () => (typeof error === "string" && error.length > 0 ? error : fallback),
    onSome: ({ message }) => message,
  });

export const messageFromExit = (exit: Exit.Exit<unknown, unknown>, fallback: string): string =>
  Option.match(Option.flatMap(Exit.findErrorOption(exit), decodeErrorMessage), {
    onNone: () => fallback,
    onSome: ({ message }) => message,
  });

export const reportExitFailure = (
  report: FrontendErrorReporter,
  exit: Exit.Exit<unknown, unknown>,
  context: FrontendErrorContext,
): void => {
  if (!Exit.isFailure(exit)) return;
  report(exit.cause, context);
};

export const useErrorMessageFromExit = (): ((
  exit: Exit.Exit<unknown, unknown>,
  fallback: string,
  context: Omit<FrontendErrorContext, "message"> & { readonly message?: string },
) => string) => {
  const report = useReportHandledError();
  return React.useCallback(
    (exit, fallback, context) => {
      const message = messageFromExit(exit, fallback);
      reportExitFailure(report, exit, { ...context, message: context.message ?? message });
      return message;
    },
    [report],
  );
};

export const reportCauseFailure = (
  report: FrontendErrorReporter,
  cause: Cause.Cause<unknown>,
  context: FrontendErrorContext,
): void => {
  report(cause, context);
};
