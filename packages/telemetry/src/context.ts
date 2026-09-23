/** Explicit telemetry-only context across Promise and HTTP boundaries. */
import { Context, Effect, Logger, Metric, Option, Stream, Tracer } from "effect";
import {
  FetchHttpClient,
  Headers,
  HttpBody,
  HttpClient,
  HttpClientRequest,
  HttpServerResponse,
  HttpTraceContext,
} from "effect/unstable/http";

/** Trusted in-process capability containing no product authority, database or credentials. */
export interface InvocationTelemetry {
  readonly context: Context.Context<never>;
}

/** Capture the tracer, loggers, registry and parent for a host-owned callback. */
export const captureTelemetry: Effect.Effect<InvocationTelemetry> = Effect.gen(function* () {
  let context = Context.make(Tracer.Tracer, yield* Tracer.Tracer).pipe(
    Context.add(Logger.CurrentLoggers, yield* Logger.CurrentLoggers),
    Context.add(Metric.MetricRegistry, yield* Metric.MetricRegistry),
  );
  const span = yield* Effect.currentSpan.pipe(Effect.option);
  if (Option.isSome(span)) context = Context.add(context, Tracer.ParentSpan, span.value);
  return { context };
});

/** Encode the active span; absent tracing remains a valid no-header case. */
export const traceHeaders: Effect.Effect<Readonly<Record<string, string>>> =
  Effect.currentSpan.pipe(
    Effect.map(HttpTraceContext.toHeaders),
    Effect.orElseSucceed(() => ({})),
  );

/** Decode W3C context and start a server span in the recipient's own telemetry runtime. */
export const withRemoteSpan =
  (request: Request, name: string) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    effect.pipe(
      Effect.withSpan(name, {
        kind: "server",
        parent: Option.getOrUndefined(
          HttpTraceContext.fromHeaders(
            Headers.fromInput({ traceparent: request.headers.get("traceparent") ?? undefined }),
          ),
        ),
      }),
    );

/** Plain fetch for app authors, correlated with the invocation and cancelled by its owner. */
export const invocationFetch = (signal: AbortSignal) =>
  Effect.gen(function* () {
    const { context } = yield* captureTelemetry;
    return (input: string | URL | Request, init?: RequestInit): Promise<Response> =>
      Effect.runPromiseWith(context)(
        Effect.gen(function* () {
          const request = yield* Effect.try(() => new Request(input, init));
          const client = yield* HttpClient.HttpClient;
          const response = yield* client.execute(HttpClientRequest.fromWeb(request)).pipe(
            Effect.withSpan("provider.http.request", {
              attributes: { "http.request.method": request.method },
            }),
            Effect.provideService(FetchHttpClient.RequestInit, {
              cache: request.cache,
              credentials: request.credentials,
              integrity: request.integrity,
              keepalive: request.keepalive,
              mode: request.mode,
              redirect: request.redirect,
              referrer: request.referrer,
              referrerPolicy: request.referrerPolicy,
            }),
            Effect.provideService(FetchHttpClient.Fetch, (url, options) =>
              globalThis.fetch(url, {
                ...options,
                signal: AbortSignal.any([
                  signal,
                  request.signal,
                  ...(options?.signal ? [options.signal] : []),
                ]),
              }),
            ),
          );
          const streamed = HttpServerResponse.fromClientResponse(response);
          const body = streamed.body;
          // Span the body's actual consumption, including streamed responses and cancellation.
          // Keep Effect's empty-body handling, cookies and content metadata intact.
          const traced =
            body instanceof HttpBody.Stream
              ? HttpServerResponse.setBody(
                  streamed,
                  HttpBody.stream(
                    body.stream.pipe(
                      Stream.withSpan("provider.http.response.read", {
                        attributes: { "http.response.status_code": response.status },
                      }),
                    ),
                    body.contentType,
                    body.contentLength,
                  ),
                )
              : streamed;
          return HttpServerResponse.toWeb(traced, {
            withoutBody: request.method === "HEAD",
            context,
          });
        }).pipe(Effect.provide(FetchHttpClient.layer)),
        { signal },
      );
  });
