import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import { Effect, Layer, Ref, Schema } from "effect";
import {
  HttpRouter,
  HttpServer,
  HttpServerRequest,
  HttpServerResponse,
} from "effect/unstable/http";
import { createServer } from "node:http";
import { templateUpstream } from "./template-upstream.ts";

/** The fake provider deliberately puts this private value in unsafe response fields. */
export const providerSecretMarker = "synthetic-private-provider-detail";
/** Provider behavior is controlled outside the real Executor server and app runtime. */
export const providerErrorUpstream = Effect.gen(function* () {
  const healthy = yield* templateUpstream;
  type Failure = {
    readonly status: number;
    readonly phase?: "call" | "discover";
    readonly headers?: Record<string, string>;
    readonly code?: string;
  };
  const state = yield* Ref.make<Failure | undefined>(undefined);
  const routes = Layer.mergeAll(
    Layer.empty,
    ...(
      [
        "/graphql",
        "/mcp",
        "/identity",
        "/openapi.json",
        "/custom/discover",
        "/custom/call",
      ] as const
    ).map((path) =>
      HttpRouter.add(
        "*",
        path,
        Effect.gen(function* () {
          const request = yield* HttpServerRequest.HttpServerRequest;
          // GitHub rejects requests from runtimes that omit an identifying User-Agent.
          if (path === "/graphql" && request.headers["user-agent"] !== "Executor")
            return yield* HttpServerResponse.json(
              { message: "User-Agent required" },
              { status: 403 },
            );
          const text = request.method === "POST" ? yield* request.text : undefined;
          const message =
            text === undefined
              ? undefined
              : yield* Schema.decodeUnknownEffect(
                  Schema.fromJsonString(
                    Schema.Struct({
                      method: Schema.optional(Schema.String),
                      query: Schema.optional(Schema.String),
                    }),
                  ),
                )(text);
          const phase =
            path === "/identity" ||
            path === "/custom/call" ||
            message?.method === "tools/call" ||
            (message?.query !== undefined && !message.query.includes("__schema"))
              ? "call"
              : "discover";
          const failure = yield* Ref.get(state);
          if (
            request.headers.authorization === "Bearer synthetic-personal" &&
            failure !== undefined &&
            (failure.phase === undefined || failure.phase === phase)
          )
            return yield* HttpServerResponse.json(
              {
                message: providerSecretMarker,
                errors: [{ message: providerSecretMarker, extensions: { code: failure.code } }],
              },
              { status: failure.status, headers: failure.headers },
            );
          if (path.startsWith("/custom/")) return yield* HttpServerResponse.json({ ok: true });
          const response = yield* Effect.tryPromise((signal) =>
            fetch(`${healthy}${path}`, {
              method: request.method,
              headers: {
                "content-type": "application/json",
                authorization: request.headers.authorization ?? "",
              },
              ...(text === undefined ? {} : { body: text }),
              signal,
            }),
          );
          return HttpServerResponse.fromWeb(response);
        }),
      ),
    ),
  );
  const services = yield* Layer.build(
    HttpRouter.serve(routes, { disableLogger: true, disableListenLog: true }).pipe(
      Layer.provideMerge(NodeHttpServer.layer(createServer, { host: "127.0.0.1", port: 0 })),
    ),
  );
  const server = yield* HttpServer.HttpServer.pipe(Effect.provideContext(services));
  if (!("port" in server.address)) return yield* Effect.die("Fixture must listen on TCP");
  return {
    origin: `http://127.0.0.1:${server.address.port}`,
    configure: (value: Failure | undefined) => Ref.set(state, value),
  };
});
