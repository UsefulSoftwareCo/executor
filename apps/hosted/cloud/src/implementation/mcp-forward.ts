import { Cause, Effect, Schema } from "effect";
import { HttpServerRequest, type HttpServerResponse } from "effect/unstable/http";
import type { HttpServerError } from "effect/unstable/http/HttpServerError";

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
