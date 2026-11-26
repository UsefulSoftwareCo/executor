import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import { Effect, Layer, Schema } from "effect";
import { HttpRouter, HttpServer, HttpServerRequest, HttpServerResponse } from "effect/http";
import { createServer } from "node:http";

export const ReceivedRequest = Schema.Struct({
  host: Schema.String,
  url: Schema.String,
  authorization: Schema.NullOr(Schema.String),
  headers: Schema.Record(Schema.String, Schema.String),
  contentType: Schema.NullOr(Schema.String),
  body: Schema.String,
  authenticated: Schema.Boolean,
});
export type ReceivedRequest = typeof ReceivedRequest.Type;

export interface IssuedCredential {
  readonly in: "header" | "query";
  readonly name: string;
  readonly value: string;
}

export const credentialUpstream = Effect.gen(function* () {
  const received: ReceivedRequest[] = [];
  const issued: IssuedCredential[] = [];
  let stored = new Uint8Array();
  const routes = HttpRouter.add(
    "*",
    "/*",
    Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest;
      const bytes = new Uint8Array(
        yield* request.arrayBuffer.pipe(Effect.orElseSucceed(() => new ArrayBuffer(0))),
      );
      const url = new URL(request.url, "http://upstream");
      const headers: Record<string, string> = { ...request.headers };
      const entry = {
        host: request.headers.host ?? "",
        url: request.url,
        authorization: request.headers.authorization ?? null,
        headers,
        contentType: request.headers["content-type"] ?? null,
        body: new TextDecoder().decode(bytes),
        authenticated: issued.some((credential) =>
          credential.in === "header"
            ? headers[credential.name] === credential.value
            : url.searchParams.getAll(credential.name).includes(credential.value),
        ),
      };
      received.push(entry);
      const pathname = url.pathname;
      if (request.method === "POST" && pathname === "/store") {
        stored = bytes;
        return HttpServerResponse.empty({ status: 204 });
      }
      if (request.method === "GET" && pathname === "/stored")
        return HttpServerResponse.uint8Array(stored, { contentType: "application/octet-stream" });
      if (issued.length > 0 && !entry.authenticated)
        return yield* HttpServerResponse.json({ error: "unauthenticated" }, { status: 401 });
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
    origin: `http://127.0.0.1:${port}`,
    undeclaredOrigin: `http://localhost:${port}`,
    received: Effect.sync(() => [...received]),
    issue: (credentials: readonly IssuedCredential[]) =>
      Effect.sync(() => {
        issued.push(...credentials);
      }),
    stored: Effect.sync(() => new TextDecoder().decode(stored)),
  };
});
