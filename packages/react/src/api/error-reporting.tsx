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
  readonly message: string;
  readonly cause: unknown;
  readonly context: FrontendErrorContext;
}> {}

const ErrorMessage = Schema.Struct({ message: Schema.String });
const decodeErrorMessage = Schema.decodeUnknownOption(ErrorMessage);

const TaggedValue = Schema.Struct({ _tag: Schema.String });
const decodeTaggedValue = Schema.decodeUnknownOption(TaggedValue);

export const messageFromUnknown = (error: unknown, fallback: string): string =>
  Option.match(decodeErrorMessage(error), {
    onNone: () => (typeof error === "string" && error.length > 0 ? error : fallback),
    onSome: ({ message }) => message,
  });

// ---------------------------------------------------------------------------
// Normalization
//
// Crash reporters (Sentry in cloud and in the desktop renderer) title and group
// an event from the reported value's `name`, `message` and `stack`. Every
// producer in this codebase starts from an Effect `Cause`, which is a plain
// object with none of the three: Sentry then synthesizes `'CauseImpl' captured
// as exception with keys: ...` and, having no message to group on, groups on
// the reporting function's own stack frame — collapsing unrelated frontend
// failures into a single message-less issue.
//
// `toReportableError` is the choke point that turns whatever a call site has
// into a real `Error` that still says what went wrong. It is idempotent: an
// `Error` in, the same `Error` out, so applying it at more than one layer is
// safe.
// ---------------------------------------------------------------------------

const contextLabel = (context: FrontendErrorContext): string =>
  `${context.surface}/${context.action}`;

const hasText = (value: string | undefined): value is string =>
  typeof value === "string" && value.trim().length > 0;

/** The best sentence available for a value that carries no usable message. */
const describeUnknown = (value: unknown, context: FrontendErrorContext): string =>
  messageFromUnknown(value, context.message ?? contextLabel(context));

/** Effect's tagged errors identify themselves by `_tag`, not by `name`. */
const nameFromUnknown = (value: unknown, fallback: string): string =>
  Option.match(decodeTaggedValue(value), {
    onNone: () => fallback,
    onSome: ({ _tag }) => _tag,
  });

/** Keep the original value reachable without clobbering an existing chain. */
const withOriginalCause = (error: Error, original: unknown): Error => {
  if (error.cause === undefined && original !== error) error.cause = original;
  return error;
};

const errorFromValue = (value: unknown, context: FrontendErrorContext): Error => {
  // oxlint-disable-next-line executor/no-error-constructor -- boundary: a crash-reporting transport only understands built-in Errors; this module is the adapter that produces them
  const error = new Error(describeUnknown(value, context));
  error.name = nameFromUnknown(value, context.surface);
  return withOriginalCause(error, value);
};

const errorFromCause = (cause: Cause.Cause<unknown>, context: FrontendErrorContext): Error => {
  // `prettyErrors` is the non-lossy conversion: it renders every reason —
  // failures AND defects — as a freshly built `Error` that keeps the original's
  // name, message and stack frames.
  const [rendered] = Cause.prettyErrors(cause);
  if (rendered === undefined) return errorFromValue(Cause.squash(cause), context);
  if (!hasText(rendered.message)) {
    // A tagged error declared without a `message` field renders with an empty
    // one — that is what produced `FrontendHandledError: No error message`.
    // The rendered Error is ours, built just above, so filling it in cannot
    // mutate a value a call site still holds, and assigning (rather than
    // rebuilding) keeps the captured stack frames intact.
    rendered.message = describeUnknown(Cause.squash(cause), context);
  }
  return withOriginalCause(rendered, cause);
};

export const toReportableError = (error: unknown, context: FrontendErrorContext): Error => {
  if (Cause.isCause(error)) return errorFromCause(error, context);
  // oxlint-disable-next-line executor/no-instanceof-error -- boundary: the report is already whatever a call site threw; deciding whether the transport can consume it as-is is this adapter's whole job
  if (error instanceof Error) {
    // oxlint-disable-next-line executor/no-unknown-error-message -- boundary: narrowed to Error above; an empty message is exactly the case being repaired
    if (hasText(error.message)) return error;
    // Never mutate an Error a call site owns: rebuild it, carrying the stack.
    // oxlint-disable-next-line executor/no-error-constructor -- boundary: a crash-reporting transport only understands built-in Errors
    const titled = new Error(describeUnknown(error, context));
    titled.name = error.name;
    if (typeof error.stack === "string") titled.stack = error.stack;
    return withOriginalCause(titled, error);
  }
  return errorFromValue(error, context);
};

/** Wraps a reporter so it can only ever be handed a titled `Error`. */
const normalizing =
  (reporter: FrontendErrorReporter): FrontendErrorReporter =>
  (error, context) => {
    reporter(toReportableError(error, context), context);
  };

// ---------------------------------------------------------------------------
// Reporters
// ---------------------------------------------------------------------------

/**
 * The fallback transport: re-throw the report as a global `error` event, which
 * an initialized crash reporter's global handlers pick up. Used by self-host
 * builds and by the desktop renderer before its Sentry client is ready.
 */
export const reportViaGlobalErrorEvent: FrontendErrorReporter = (error, context) => {
  if (typeof globalThis.reportError !== "function") return;
  const reportable = toReportableError(error, context);
  globalThis.reportError(
    new FrontendHandledError({
      message: `${contextLabel(context)}: ${reportable.message}`,
      cause: reportable,
      context,
    }),
  );
};

export type FrontendErrorScope = {
  readonly setTag: (key: string, value: string) => unknown;
  readonly setContext: (key: string, value: Record<string, unknown> | null) => unknown;
};

/**
 * The one Sentry-shaped reporter both product shells use. `captureException`
 * stays a parameter so this module never depends on a Sentry package — cloud
 * passes `@sentry/react`'s, the desktop renderer passes the lazily imported
 * `@sentry/browser` one.
 */
export const createSentryFrontendErrorReporter =
  (
    captureException: (error: Error, applyScope: (scope: FrontendErrorScope) => void) => void,
  ): FrontendErrorReporter =>
  (error, context) => {
    captureException(toReportableError(error, context), (scope) => {
      scope.setTag("executor.ui.surface", context.surface);
      scope.setTag("executor.ui.action", context.action);
      scope.setTag("executor.ui.severity", context.severity ?? "error");
      scope.setContext("executor.ui", {
        surface: context.surface,
        action: context.action,
        message: context.message,
        metadata: context.metadata,
      });
    });
  };

const FrontendErrorReporterContext = React.createContext<FrontendErrorReporter>(
  normalizing(reportViaGlobalErrorEvent),
);

let currentFrontendErrorReporter = normalizing(reportViaGlobalErrorEvent);

export const reportHandledFrontendError = (error: unknown, context: FrontendErrorContext): void => {
  currentFrontendErrorReporter(error, context);
};

export const FrontendErrorReporterProvider = (
  props: React.PropsWithChildren<{ reporter?: FrontendErrorReporter }>,
) => {
  // Memoized so the wrapper keeps a stable identity across renders: consumers
  // list it in `useCallback` dependencies.
  const reporter = React.useMemo(
    () => normalizing(props.reporter ?? reportViaGlobalErrorEvent),
    [props.reporter],
  );
  currentFrontendErrorReporter = reporter;
  return (
    <FrontendErrorReporterContext.Provider value={reporter}>
      {props.children}
    </FrontendErrorReporterContext.Provider>
  );
};

export const useReportHandledError = (): FrontendErrorReporter =>
  React.useContext(FrontendErrorReporterContext);

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
  report(toReportableError(exit.cause, context), context);
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
  report(toReportableError(cause, context), context);
};
