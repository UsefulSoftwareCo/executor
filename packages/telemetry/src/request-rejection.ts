/**
 * Request decoding rejections are client errors. Effect's HTTP API answers them
 * with an empty 400 before any handler runs, so the request span is the only
 * place that can record why. Incident reporting skips them.
 */
import { Context, Effect, ErrorReporter, Option, type SchemaIssue, Tracer } from "effect";
import { HttpApiError } from "effect/unstable/httpapi";

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
const segment = (key: PropertyKey) =>
  typeof key === "number" ? `[${key}]` : `.${String(key).slice(0, 64)}`;

/** Issue locations and categories only. Values, messages and annotations can echo request content. */
const issueSummary = (issue: SchemaIssue.Issue, path: string): ReadonlyArray<string> => {
  switch (issue._tag) {
    case "Pointer":
      return issueSummary(issue.issue, path + issue.path.map(segment).join(""));
    case "Encoding":
      return issueSummary(issue.issue, path);
    case "Composite":
      return issue.issues.flatMap((inner) => issueSummary(inner, path));
    // A union lists why each member rejected the value.
    case "AnyOf":
      return issue.issues.length === 0
        ? [`${path}: AnyOf`]
        : issue.issues.flatMap((inner) => issueSummary(inner, path));
    default:
      return [`${path}: ${issue._tag}`];
  }
};

/** Record the rejection on the span that owns the rejected request. */
const recorder: ErrorReporter.ErrorReporter = {
  [ErrorReporter.TypeId]: ErrorReporter.TypeId,
  report: ({ cause, fiber }) => {
    for (const reason of cause.reasons) {
      const error =
        reason._tag === "Fail" ? reason.error : reason._tag === "Die" ? reason.defect : undefined;
      if (!isRequestRejection(error)) continue;
      const span = Context.getOption(fiber.context, Tracer.ParentSpan);
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
