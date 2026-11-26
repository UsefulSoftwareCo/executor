import { Cause, Effect, Option, Schema, Stream } from "effect";
import { HttpBody, HttpServerRequest, HttpServerResponse } from "effect/http";
import type { HttpServerError } from "effect/http/HttpServerError";
import { providerFailureCode } from "./provider-failure.ts";

export const refuseTooDeep = <E, R>(
  forward: Effect.Effect<HttpServerResponse.HttpServerResponse, E, R>,
) =>
  forward.pipe(
    Effect.catchCause((cause) => {
      const error = Cause.squash(cause);
      if (
        Cause.hasInterrupts(cause) ||
        !(error instanceof Error) ||
        !error.message.startsWith("Subrequest depth limit exceeded.")
      )
        return Effect.failCause(cause);
      return Effect.annotateCurrentSpan("executor.mcp.refused", "subrequest-depth").pipe(
        Effect.as(
          HttpServerResponse.jsonUnsafe(
            {
              jsonrpc: "2.0",
              id: null,
              error: {
                code: -32000,
                message:
                  "Subrequest depth limit exceeded: this request reached Executor after passing through Cloudflare Workers too many times, so Cloudflare refused Executor's next step. The Worker or Durable Object that called Executor is nested too deeply, often because it calls itself or other Workers recursively. Call Executor from a shallower point in that chain",
              },
            },
            { status: 508, headers: { "cache-control": "no-store" } },
          ),
        ),
      );
    }),
  );

const RpcMessage = Schema.Struct({
  id: Schema.optional(Schema.Union([Schema.String, Schema.Number])),
});
const Requests = Schema.Union([RpcMessage, Schema.Array(RpcMessage)]);

const memoryLimitMessage =
  "Executor's MCP session ran out of memory while answering this request, so its response was lost: the Durable Object running it, or another in the same isolate, exceeded Cloudflare's 128 MB memory limit and was reset. A very large result is the usual cause. Executor sets no limit on a result, but Cloud holds one several times over while sending it, so a result of a few tens of megabytes can exceed the limit. Return less, such as selected fields, a count or one page. Tool calls made before this may have completed, so check current state before running the same work again";

const memoryLimitAnswer = (body: Option.Option<unknown>) =>
  Option.getOrUndefined(
    Option.flatMap(Option.flatMap(body, Schema.decodeUnknownOption(Requests)), (requests) => {
      const errors = (Array.isArray(requests) ? requests : [requests]).flatMap(({ id }) =>
        id === undefined
          ? []
          : [{ jsonrpc: "2.0", id, error: { code: -32603, message: memoryLimitMessage } }],
      );
      return errors.length === 0
        ? Option.none()
        : Option.some({ errors, json: Array.isArray(requests) ? errors : errors[0] });
    }),
  );

export const answerMemoryLimit =
  (body: Option.Option<unknown>) =>
  <E, R>(forward: Effect.Effect<HttpServerResponse.HttpServerResponse, E, R>) => {
    const answer = memoryLimitAnswer(body);
    if (answer === undefined) return forward;
    const exceeded = (cause: Cause.Cause<unknown>) =>
      !Cause.hasInterruptsOnly(cause) &&
      providerFailureCode(Cause.squash(cause)) === "memory_limit";
    const refused = Effect.annotateCurrentSpan("executor.mcp.refused", "memory-limit");
    return forward.pipe(
      Effect.catchCause((cause) =>
        exceeded(cause)
          ? refused.pipe(
              Effect.as(
                HttpServerResponse.jsonUnsafe(answer.json, {
                  headers: { "cache-control": "no-store" },
                }),
              ),
            )
          : Effect.failCause(cause),
      ),
      Effect.map((response) => {
        const body = response.body;
        if (!(body instanceof HttpBody.Stream) || !body.contentType.startsWith("text/event-stream"))
          return response;
        let tail = [10, 10];
        const events = new TextEncoder().encode(
          answer.errors.map((error) => `data: ${JSON.stringify(error)}\n\n`).join(""),
        );
        return HttpServerResponse.setBody(
          response,
          HttpBody.stream(
            body.stream.pipe(
              Stream.tap((chunk) =>
                Effect.sync(() => {
                  tail = [...tail, ...chunk.subarray(-2)].slice(-2);
                }),
              ),
              Stream.catchCause((cause) =>
                exceeded(cause)
                  ? Stream.make(
                      tail[0] === 10 && tail[1] === 10
                        ? events
                        : new Uint8Array([10, 10, ...events]),
                    )
                  : Stream.failCause(cause),
              ),
            ),
            body.contentType,
          ),
        );
      }),
    );
  };

const Initialize = Schema.Struct({
  jsonrpc: Schema.Literal("2.0"),
  method: Schema.Literal("initialize"),
  id: Schema.Union([Schema.String, Schema.Number]),
});

export const forwardMcpRequest = (
  request: HttpServerRequest.HttpServerRequest,
  forward: (
    request: HttpServerRequest.HttpServerRequest,
  ) => Effect.Effect<HttpServerResponse.HttpServerResponse, HttpServerError>,
) =>
  Effect.gen(function* () {
    if (
      request.method !== "POST" ||
      request.headers["mcp-session-id"] !== undefined ||
      !/^\/(?:org\/[^/]+\/)?mcp$/.test(new URL(request.url, "https://mcp.internal").pathname)
    )
      return yield* forward(request);
    const web = yield* HttpServerRequest.toWeb(request);
    const attempt = Effect.suspend(() =>
      forward(HttpServerRequest.fromWeb(new Request(web.clone(), { headers: request.headers }))),
    );
    return yield* attempt.pipe(
      Effect.catchCause((cause) =>
        Effect.gen(function* () {
          const error = Cause.squash(cause);
          if (
            Cause.hasInterrupts(cause) ||
            !(error instanceof Error) ||
            error.message !==
              "Connection closed: this Durable Object instance is no longer active. Reconnect or retry the request."
          )
            return yield* Effect.failCause(cause);
          const initialize = yield* Effect.tryPromise(() => web.clone().json()).pipe(
            Effect.map(Schema.is(Initialize)),
            Effect.catch(() => Effect.succeed(false)),
          );
          if (!initialize) return yield* Effect.failCause(cause);
          yield* Effect.logWarning("MCP initialization reconnecting after inactive Durable Object");
          return yield* attempt;
        }),
      ),
    );
  });
