/** Error-only Sentry integration with one client and isolated scope per Worker request. */
import { CloudflareClient, Scope, createTransport } from "@sentry/cloudflare";
import { createStackParser, nodeStackLineParser } from "@sentry/core";
import { CurrentRuntimeContext } from "alchemy/RuntimeContext";
import { Cause, Context, Effect, ErrorReporter, Option, Schema, SchemaAST, Tracer } from "effect";
import { CurrentUserId, CurrentOrganization } from "@executor-js/hosted-server";

// Match Sentry's Cloudflare parser: Worker module names are relative, while
// uploaded release artifacts use root-relative paths.
const [stackPriority, parseStackLine] = nodeStackLineParser();
const workerStackParser = createStackParser([
  stackPriority,
  (line) => {
    const frame = parseStackLine(line);
    if (!frame) return frame;
    return {
      ...frame,
      ...(frame.filename === undefined
        ? {}
        : { abs_path: frame.filename.startsWith("/") ? frame.filename : `/${frame.filename}` }),
      in_app: frame.filename !== undefined,
    };
  },
]);

const Settings = Schema.Struct({
  dsn: Schema.String,
  environment: Schema.String,
  release: Schema.String,
});
/** The reporting boundary never replaces the failure of a product operation. */
export class SentryTransportFailed extends Schema.TaggedError<SentryTransportFailed>()(
  "SentryTransportFailed",
  {},
) {}
interface Reporter {
  readonly capture: (cause: Cause.Cause<unknown>) => Effect.Effect<void>;
}
const Reporter = Context.Reference<Reporter>("cloud/SentryReporter", {
  defaultValue: () => ({ capture: () => Effect.void }),
});

/** Capture a handled Effect failure before an API or runtime adapter translates it. */
export const reportCloudFailure = (cause: Cause.Cause<unknown>) =>
  Effect.flatMap(Reporter, (reporter) => reporter.capture(cause));

/** Build a request-local client; Effect/Alchemy owns the final flush through waitUntil. */
export const withCloudSentry = <A, E, R>(
  handler: Effect.Effect<A, E, R>,
  settings: Effect.Effect<unknown>,
) =>
  Effect.gen(function* () {
    const value = yield* settings;
    if (value === undefined || value === null) return yield* handler;
    const config = yield* Schema.decodeUnknownEffect(Settings)(value).pipe(Effect.orDie);
    const client = yield* Effect.acquireRelease(
      Effect.sync(() => {
        const client = new CloudflareClient({
          ...config,
          integrations: [],
          tracesSampleRate: 0,
          sendDefaultPii: false,
          stackParser: workerStackParser,
          transport: (options) =>
            createTransport(options, async (request) => {
              const response = await fetch(options.url, {
                method: "POST",
                body:
                  typeof request.body === "string" ? request.body : new Uint8Array(request.body),
                ...(options.headers === undefined ? {} : { headers: options.headers }),
              });
              await response.arrayBuffer();
              return {
                statusCode: response.status,
                headers: {
                  "x-sentry-rate-limits": response.headers.get("x-sentry-rate-limits"),
                  "retry-after": response.headers.get("retry-after"),
                },
              };
            }),
        });
        client.init();
        return client;
      }),
      (client) =>
        Effect.tryPromise({
          try: () => client.flush(2000),
          catch: () => new SentryTransportFailed(),
        }).pipe(
          Effect.flatMap((flushed) =>
            flushed ? Effect.void : Effect.logWarning("Sentry error export timed out"),
          ),
          Effect.catch(() => Effect.logWarning("Sentry error export failed")),
          Effect.ensuring(Effect.sync(() => client.dispose())),
        ),
    );
    const seen = new Set<unknown>();
    const captureIn = (cause: Cause.Cause<unknown>, context: Context.Context<never>) => {
      if (Cause.hasInterruptsOnly(cause)) return;
      const exception = Cause.squash(cause);
      if (ErrorReporter.isIgnored(exception) || seen.has(exception)) return;
      // Declared client rejections remain in request/operation telemetry. Only
      // unexpected failures and server errors become Sentry incidents.
      if (exception instanceof Error && Schema.isSchema(exception.constructor)) {
        const status = SchemaAST.resolveAt<unknown>("httpApiStatus")(exception.constructor.ast);
        if (typeof status === "number" && status >= 400 && status < 500) return;
      }
      seen.add(exception);
      const scope = new Scope();
      scope.setClient(client);
      scope.setTag("product_version", "v2");
      scope.setTag(
        "executor_test",
        config.environment.startsWith("test-") || config.environment === "verification",
      );
      const actor = Context.get(context, CurrentUserId);
      if (actor !== undefined) scope.setUser({ id: actor });
      const organization = Context.getOption(context, CurrentOrganization);
      if (Option.isSome(organization))
        scope.setTag("organization_id", organization.value.organization);
      const span = Context.getOption(context, Tracer.ParentSpan);
      if (Option.isSome(span)) {
        scope.setContext("trace", { trace_id: span.value.traceId, span_id: span.value.spanId });
        if (span.value._tag === "Span") {
          for (const key of [
            "executor.app.id",
            "executor.deployment.id",
            "executor.run.id",
            "executor.operation.id",
            "executor.attempt.id",
          ]) {
            const value = span.value.attributes.get(key);
            if (typeof value === "string") scope.setTag(key, value);
          }
        }
      }
      client.captureException(exception, undefined, scope);
    };
    const capture = (cause: Cause.Cause<unknown>) =>
      Effect.withFiber((fiber) => Effect.sync(() => captureIn(cause, fiber.context)));
    const nativeReporter = ErrorReporter.make(({ cause, fiber }) =>
      captureIn(cause, fiber.context),
    );
    return yield* handler.pipe(
      Effect.tapCause(capture),
      Effect.provideService(Reporter, { capture }),
      Effect.provide(ErrorReporter.layer([nativeReporter], { mergeWithExisting: true })),
    );
  });

/** Resolve the binding accessor at initialization, preserving native Alchemy event context. */
export const cloudSentry = Effect.gen(function* () {
  const context = yield* CurrentRuntimeContext;
  const settings = context ? context.get<unknown>("EXECUTOR_SENTRY") : Effect.succeed(undefined);
  return <A, E, R>(handler: Effect.Effect<A, E, R>) => withCloudSentry(handler, settings);
});
