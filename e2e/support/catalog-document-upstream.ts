import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import { Effect, Layer, Ref } from "effect";
import { HttpRouter, HttpServer, HttpServerRequest, HttpServerResponse } from "effect/http";
import { createServer } from "node:http";

export const catalogDocumentUpstream = (document: (origin: string) => unknown) =>
  Effect.gen(function* () {
    const current = yield* Ref.make(document);
    const downloads = yield* Ref.make(0);
    const queries = yield* Ref.make<ReadonlyArray<string>>([]);
    const published = HttpRouter.add(
      "GET",
      "/openapi.json",
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest;
        yield* Ref.update(downloads, (count) => count + 1);
        const served = yield* Ref.get(current);
        return yield* HttpServerResponse.json(served(`http://${request.headers.host}`));
      }),
    );
    const catalog = HttpRouter.add(
      "GET",
      "/api/organizations/:organization/catalog",
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest;
        const search = new URL(request.url, "http://upstream.invalid").search;
        yield* Ref.update(queries, (all) => [...all, search]);
        return yield* HttpServerResponse.json([]);
      }),
    );
    const services = yield* Layer.build(
      HttpRouter.serve(Layer.mergeAll(published, catalog), {
        disableLogger: true,
        disableListenLog: true,
      }).pipe(
        Layer.provideMerge(NodeHttpServer.layer(createServer, { host: "127.0.0.1", port: 0 })),
      ),
    );
    const server = yield* HttpServer.HttpServer.pipe(Effect.provideContext(services));
    if (!("port" in server.address)) return yield* Effect.die("The API must listen on TCP");
    return {
      origin: `http://127.0.0.1:${server.address.port}`,
      publish: (next: (origin: string) => unknown) => Ref.set(current, next),
      downloads: Ref.get(downloads),
      queries: Ref.get(queries),
    };
  });
