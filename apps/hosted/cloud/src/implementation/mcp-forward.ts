import { Cause, Effect, Option, Schema, Stream } from "effect";
import { HttpBody, HttpServerRequest, HttpServerResponse } from "effect/http";
import type { HttpServerError } from "effect/http/HttpServerError";
import { providerFailureCode } from "./provider-failure.ts";

/**
 * Cloudflare refuses a call to a Worker or Durable Object once its request has entered the
 * Workers runtime too many times (at most 32 Worker invocations per request). A client calling
 * from deep inside its own Worker chain, often one that calls itself, reaches that limit at the
 * gateway's call to the session object. The object never ran, and the same request from the same
 * depth is refused again, so the client is told why instead of getting an empty 500.
 */
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
/** A POST body's message, or batch of messages. */
const Requests = Schema.Union([RpcMessage, Schema.Array(RpcMessage)]);

const memoryLimitMessage =
  "Executor's MCP session ran out of memory while answering this request, so its response was lost: the Durable Object running it, or another in the same isolate, exceeded Cloudflare's 128 MB memory limit and was reset. A very large result is the usual cause. Executor sets no limit on a result, but Cloud holds one several times over while sending it, so a result of a few tens of megabytes can exceed the limit. Return less, such as selected fields, a count or one page. Tool calls made before this may have completed, so check current state before running the same work again";

/**
 * The errors answering each request in a POST body whose response was lost, one event each on a
 * stream, and as JSON in the shape the body had. Undefined when no message expects a response.
 */
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

/**
 * When the session object exceeds its isolate's memory limit while answering, its response is
 * lost: the object's fetch fails, or its event stream ends without the answer. The gateway runs
 * in another isolate and sees that failure, so it answers each request in the POST with an error
 * that names the limit. Without it the client waits for an answer until its own timeout. Apply
 * it outside `observeMcpStream`, which records the failure. `body` is the POST body as JSON
 * (`parseMcpBody`).
 */
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
        // The last two bytes sent. An event the failure cut off is ended first, so the error is
        // an event of its own.
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
                // The stream's close records the failure; this only answers the client.
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

/** Only a new session handshake is safe to repeat after an ambiguous connection loss. */
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
          // Rebuild the body and acquire a fresh stub. A second failure propagates unchanged.
          return yield* attempt;
        }),
      ),
    );
  });
