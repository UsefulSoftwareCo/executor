import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import { Effect, Layer, Ref, Schema } from "effect";
import {
  HttpBody,
  HttpClient,
  HttpClientRequest,
  HttpMethod,
  HttpRouter,
  HttpServer,
  HttpServerRequest,
  HttpServerResponse,
} from "effect/http";
import { createServer } from "node:http";
import { publicTemplateUpstream, templateUpstream } from "./template-upstream.ts";

export const providerSecretMarker = "synthetic-private-provider-detail";
const makeProviderErrorUpstream = Effect.fn(function* (healthyUpstream: typeof templateUpstream) {
  const healthy = yield* healthyUpstream;
  const http = yield* HttpClient.HttpClient;
  type Failure = {
    readonly status: number;
    readonly phase?: "call" | "discover";
    readonly headers?: Record<string, string>;
    readonly code?: string;
    readonly body?: unknown;
    readonly accounts?: "all";
    readonly delayMs?: number;
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
            failure !== undefined &&
            (failure.accounts === "all" ||
              request.headers.authorization === "Bearer synthetic-personal") &&
            (failure.phase === undefined || failure.phase === phase)
          ) {
            if (failure.delayMs !== undefined) yield* Effect.sleep(failure.delayMs);
            return yield* HttpServerResponse.json(
              failure.body ?? {
                message: providerSecretMarker,
                errors: [{ message: providerSecretMarker, extensions: { code: failure.code } }],
              },
              { status: failure.status, headers: failure.headers },
            );
          }
          if (path.startsWith("/custom/")) return yield* HttpServerResponse.json({ ok: true });
          if (!HttpMethod.isHttpMethod(request.method))
            return yield* HttpServerResponse.json({ error: "unsupported method" }, { status: 405 });
          const response = yield* http.execute(
            HttpClientRequest.make(request.method)(`${healthy}${path}`, {
              headers: {
                "content-type": "application/json",
                ...(request.headers.authorization === undefined
                  ? {}
                  : { authorization: request.headers.authorization }),
              },
              ...(text === undefined ? {} : { body: HttpBody.text(text, "application/json") }),
            }),
          );
          return HttpServerResponse.fromClientResponse(response);
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

export const providerErrorUpstream = makeProviderErrorUpstream(templateUpstream);
export const publicProviderErrorUpstream = makeProviderErrorUpstream(publicTemplateUpstream);
