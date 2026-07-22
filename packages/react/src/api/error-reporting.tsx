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

export type FrontendErrorCapturePayload = {
  readonly exception: Error;
  readonly causePretty: string | null;
};

class FrontendHandledError extends Data.TaggedError("FrontendHandledError")<{
  readonly cause: unknown;
  readonly context: FrontendErrorContext;
}> {}

const MAX_FRONTEND_CAUSE_PRETTY_CHARS = 4_000;

const ErrorMessage = Schema.Struct({ message: Schema.String });
const decodeErrorMessage = Schema.decodeUnknownOption(ErrorMessage);

const isRecord = (input: unknown): input is Record<string, unknown> =>
  typeof input === "object" && input !== null;

const truncateCausePretty = (pretty: string): string =>
  pretty.length <= MAX_FRONTEND_CAUSE_PRETTY_CHARS
    ? pretty
    : `${pretty.slice(0, MAX_FRONTEND_CAUSE_PRETTY_CHARS)}\n[truncated ${pretty.length - MAX_FRONTEND_CAUSE_PRETTY_CHARS} chars]`;

const formatUnknownForErrorMessage = (input: unknown): string => {
  if (typeof input === "string") return input.length > 0 ? input : "(empty string)";
  if (input === null || input === undefined) return String(input);
  if (
    typeof input === "number" ||
    typeof input === "boolean" ||
    typeof input === "bigint" ||
    typeof input === "symbol"
  ) {
    return String(input);
  }
  // oxlint-disable-next-line executor/no-try-catch-or-throw -- boundary: stringify arbitrary unknown values for a Sentry error message; JSON.stringify throws on cycles
  try {
    const json = JSON.stringify(input);
    if (json) return json;
  } catch {
    return Object.prototype.toString.call(input);
  }
  return Object.prototype.toString.call(input);
};

const causeFromUnknown = (input: unknown): Cause.Cause<unknown> | null => {
  if (Cause.isCause(input)) return input;
  if (isRecord(input) && Cause.isCause(input.cause)) return input.cause;
  return null;
};

const errorFromCause = (cause: Cause.Cause<unknown>, pretty: string): Error => {
  const squashed = Cause.squash(cause);
  // oxlint-disable-next-line executor/no-instanceof-error -- boundary: deciding whether the squashed failure is already a Sentry-ready Error payload
  if (squashed instanceof Error) return squashed;
  const prettyError = Cause.prettyErrors(cause)[0];
  if (prettyError) return prettyError;
  // oxlint-disable-next-line executor/no-error-constructor -- boundary: Sentry needs an Error payload for Effect causes
  return new Error(pretty.length > 0 ? pretty : "Effect cause contained no failures");
};

export const frontendErrorCapturePayload = (input: unknown): FrontendErrorCapturePayload => {
  const cause = causeFromUnknown(input);
  if (cause !== null) {
    const causePretty = truncateCausePretty(Cause.pretty(cause));
    return {
      exception: errorFromCause(cause, causePretty),
      causePretty: causePretty.length > 0 ? causePretty : null,
    };
  }

  // oxlint-disable-next-line executor/no-instanceof-error -- boundary: deciding whether the incoming unknown is already a Sentry-ready Error payload
  if (input instanceof Error) {
    return { exception: input, causePretty: null };
  }

  return {
    // oxlint-disable-next-line executor/no-error-constructor -- boundary: Sentry needs an Error payload for non-Error frontend failures
    exception: new Error(`Non-Error frontend exception: ${formatUnknownForErrorMessage(input)}`),
    causePretty: null,
  };
};

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
