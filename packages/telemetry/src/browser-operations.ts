/** Correlate transport and decoded outcomes without exporting response bodies or errors. */
import { Cause, Context, Effect, Exit, Schema, SchemaAST, Tracer } from "effect";
import { HttpClient, HttpClientError } from "effect/unstable/http";
import { TraceContext } from "./trace-context.ts";

let pageId: string | undefined;
/** A random document identity. It is never an authentication or user identifier. */
export const browserPageId = () => (pageId ??= crypto.randomUUID());

/** Safe event shared with the host's error reporter and product analytics. */
export const BrowserOperationFailure = Schema.Struct({
  error_type: Schema.Literals([
    "BrowserDecodeFailed",
    "BrowserTransportFailed",
    "BrowserOperationFailed",
  ]),
  trace_id: TraceContext.fields.traceId,
  span_id: TraceContext.fields.spanId,
  page_id: Schema.String,
});
const ResponseTrace = Context.Reference<TraceContext | undefined>("telemetry/ResponseTrace", {
  defaultValue: () => undefined,
});
const setResponseTrace = (value: TraceContext | undefined) =>
  Effect.withFiber((fiber) => {
    // The generated client executes transport then decoding on this fiber. Consume
    // once at decoding; parallel requests have independent fiber contexts.
    fiber.setContext(Context.add(fiber.context, ResponseTrace, value));
    return Effect.void;
  });
const observe = <A, E, R>(effect: Effect.Effect<A, E, R>, name: string) =>
  Effect.gen(function* () {
    const result = yield* Effect.useSpan(name, (span) =>
      Effect.gen(function* () {
        yield* Effect.annotateCurrentSpan("executor.page.id", browserPageId());
        const exit = yield* Effect.exit(effect);
        if (Exit.isFailure(exit)) {
          const error = Cause.squash(exit.cause);
          const interrupted = Cause.hasInterruptsOnly(exit.cause);
          const status =
            error instanceof Error && Schema.isSchema(error.constructor)
              ? SchemaAST.resolveAt<unknown>("httpApiStatus")(error.constructor.ast)
              : undefined;
          const expected = typeof status === "number" && status >= 400 && status < 500;
          const kind = Schema.isSchemaError(error)
            ? "BrowserDecodeFailed"
            : HttpClientError.isHttpClientError(error)
              ? "BrowserTransportFailed"
              : "BrowserOperationFailed";
          yield* Effect.annotateCurrentSpan({
            "executor.outcome": interrupted ? "cancelled" : "failed",
            "error.type": kind,
            "executor.error.expected": expected,
          });
          if (!interrupted && !expected)
            window.dispatchEvent(
              new CustomEvent("executor:operation-failed", {
                detail: {
                  error_type: kind,
                  trace_id: span.traceId,
                  span_id: span.spanId,
                  page_id: browserPageId(),
                },
              }),
            );
        } else yield* Effect.annotateCurrentSpan("executor.outcome", "completed");
        return {
          exit,
          trace: { traceId: span.traceId, spanId: span.spanId, sampled: span.sampled },
        };
      }).pipe(Effect.withParentSpan(span)),
    );
    return result;
  });

/** Observe transport failure and retain only its trace identity for the subsequent decoder. */
export const observeBrowserTransport = (client: HttpClient.HttpClient) =>
  client.pipe(
    HttpClient.transformResponse((effect) =>
      Effect.gen(function* () {
        yield* setResponseTrace(undefined);
        const result = yield* observe(effect, "ui.api.transport");
        if (Exit.isSuccess(result.exit)) yield* setResponseTrace(result.trace);
        return yield* result.exit;
      }),
    ),
  );

/** AtomHttpApi invokes this after status/body decoding, including handled schema failures. */
export const observeBrowserResponse = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const parent = yield* ResponseTrace;
    yield* setResponseTrace(undefined);
    const work = observe(effect, "ui.api");
    const result = yield* parent === undefined
      ? work
      : work.pipe(Effect.withParentSpan(Tracer.externalSpan(parent)));
    return yield* result.exit;
  });
