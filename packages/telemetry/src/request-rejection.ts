/**
 * Request decoding rejections are client errors, rejected before any handler runs. Product APIs
 * answer them with `RequestInvalid` through their `RequestRejection` middleware, which records
 * them here; other endpoints answer an empty 400, and this reporter records why on the request
 * span. Incident reporting skips them.
 */
import { Context, Effect, ErrorReporter, Option, Tracer } from "effect";
import { HttpApiError } from "effect/http-api";
import { issueSummary } from "./schema-issue.ts";

/** Request parts the caller supplies. Response encoding failures (Body, ResponseHeaders) are server faults. */
const requestKinds: ReadonlySet<HttpApiError.HttpApiSchemaError["kind"]> = new Set([
  "Params",
  "Headers",
  "Query",
  "Payload",
]);

/** Did an endpoint reject the shape of the caller's request? */
export const isRequestRejection = (error: unknown): error is HttpApiError.HttpApiSchemaError =>
  HttpApiError.HttpApiSchemaError.is(error) && requestKinds.has(error.kind);

const maxIssues = 10;
/** Record a rejection on the span that owns the rejected request. */
const record = (error: HttpApiError.HttpApiSchemaError, context: Context.Context<never>) => {
  const span = Context.getOption(context, Tracer.ParentSpan);
  if (Option.isNone(span) || span.value._tag !== "Span") return;
  // Union members can repeat the same finding.
  const issues = [...new Set(issueSummary(error.cause.issue, "$"))];
  span.value.attribute("error.type", "HttpApiSchemaError");
  span.value.attribute("executor.request.rejection.kind", error.kind);
  span.value.attribute(
    "executor.request.rejection.issues",
    [
      ...issues.slice(0, maxIssues),
      ...(issues.length > maxIssues ? [`+${issues.length - maxIssues} more`] : []),
    ].join(", "),
  );
};

/** Record a request rejection on the current request's span, for code that answers it itself. */
export const recordRequestRejection = (error: HttpApiError.HttpApiSchemaError) =>
  Effect.withFiber((fiber) => Effect.sync(() => record(error, fiber.context)));

const recorder: ErrorReporter.ErrorReporter = {
  [ErrorReporter.TypeId]: ErrorReporter.TypeId,
  report: ({ cause, fiber }) => {
    for (const reason of cause.reasons) {
      const error =
        reason._tag === "Fail" ? reason.error : reason._tag === "Die" ? reason.defect : undefined;
      if (!isRequestRejection(error)) continue;
      record(error, fiber.context);
      return;
    }
  },
};

/** Wrap a host's request handler so HTTP API request rejections are recorded on its span. */
export const recordRequestRejections = <A, E, R>(handler: Effect.Effect<A, E, R>) =>
  Effect.withFiber((fiber) =>
    Effect.provideService(
      handler,
      ErrorReporter.CurrentErrorReporters,
      new Set([...fiber.getRef(ErrorReporter.CurrentErrorReporters), recorder]),
    ),
  );
