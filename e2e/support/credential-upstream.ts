/**
 * A loopback service that records what each request actually carried and echoes it back. The
 * record shows the values the service received; the echo shows what app code reads in reply.
 */
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import { Effect, Layer, Schema } from "effect";
import { HttpRouter, HttpServer, HttpServerRequest, HttpServerResponse } from "effect/http";
import { createServer } from "node:http";

/** One request as the service received it. */
export const ReceivedRequest = Schema.Struct({
  host: Schema.String,
  url: Schema.String,
  authorization: Schema.NullOr(Schema.String),
  apiKey: Schema.NullOr(Schema.String),
  contentType: Schema.NullOr(Schema.String),
  body: Schema.String,
});
export type ReceivedRequest = typeof ReceivedRequest.Type;

/** Start the service on 127.0.0.1 and close it with the case scope. */
export const credentialUpstream = Effect.gen(function* () {
  const received: ReceivedRequest[] = [];
  const routes = HttpRouter.add(
    "*",
    "/*",
    Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest;
      const entry = {
        host: request.headers.host ?? "",
        url: request.url,
        authorization: request.headers.authorization ?? null,
        apiKey: request.headers["x-api-key"] ?? null,
        contentType: request.headers["content-type"] ?? null,
        body: yield* request.text.pipe(Effect.orElseSucceed(() => "")),
      };
      received.push(entry);
      // A service that echoes credentials, as some error and debug responses do.
      return yield* HttpServerResponse.json(entry, {
        headers: { "x-echo-authorization": entry.authorization ?? "" },
      });
    }),
  );
  const listener = yield* Effect.sync(() => createServer());
  const services = yield* Layer.build(
    HttpRouter.serve(routes, { disableLogger: true, disableListenLog: true }).pipe(
      Layer.provideMerge(NodeHttpServer.layer(() => listener, { host: "127.0.0.1", port: 0 })),
    ),
  );
  yield* Effect.addFinalizer(() => Effect.sync(() => listener.closeAllConnections()));
  const server = yield* HttpServer.HttpServer.pipe(Effect.provideContext(services));
  if (!("port" in server.address))
    return yield* Effect.die("Credential upstream needs a TCP listener");
  const port = server.address.port;
  return {
    port,
    /** The origin the provider declares as its credential host. */
    origin: `http://127.0.0.1:${port}`,
    /** The same listener under a name the provider does not declare. */
    undeclaredOrigin: `http://localhost:${port}`,
    received: Effect.sync(() => [...received]),
  };
});
