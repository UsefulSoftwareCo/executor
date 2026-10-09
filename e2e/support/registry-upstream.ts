/** A synthetic public app registry. Each requested name selects one response the product must classify. */
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import { Effect, Exit, Layer, Ref, Scope } from "effect";
import { HttpRouter, HttpServer, HttpServerRequest, HttpServerResponse } from "effect/http";
import { createServer } from "node:http";

export const registryPublication = {
  name: "@fixture/example",
  commit: "a".repeat(40),
  description: "A shared example",
  publishedAt: "2026-01-01T00:00:00.000Z",
};

/** Package names that select each upstream behavior. */
export const registryFixtureNames = {
  redirect: "@fixture/moved",
  unavailable: "@fixture/down",
  garbled: "@fixture/garbled",
  missing: "@fixture/missing",
} as const;

/**
 * Start the registry on loopback. `paths` lists every received request. `close` stops the
 * listener early so later reads cannot connect; the case scope otherwise closes it.
 */
export const registryUpstream = Effect.gen(function* () {
  const listener = yield* Scope.make();
  yield* Effect.addFinalizer(() => Scope.close(listener, Exit.void));
  const paths = yield* Ref.make<ReadonlyArray<string>>([]);
  const list = HttpServerResponse.jsonUnsafe([registryPublication]);
  const routes = Layer.mergeAll(
    HttpRouter.add(
      "GET",
      "/api/registry/apps",
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest;
        const url = new URL(request.url, "http://registry.invalid");
        yield* Ref.update(paths, (all) => [...all, url.pathname + url.search]);
        switch (url.searchParams.get("name")) {
          case registryFixtureNames.redirect:
            // A followed redirect would succeed here, so only a refused redirect fails.
            return HttpServerResponse.empty({ status: 302, headers: { location: "/elsewhere" } });
          case registryFixtureNames.unavailable:
            return HttpServerResponse.text("unavailable", { status: 503 });
          case registryFixtureNames.garbled:
            return HttpServerResponse.html("<html></html>");
          case registryFixtureNames.missing:
            return HttpServerResponse.jsonUnsafe(
              { _tag: "RegistryError", reason: "not-found" },
              { status: 400 },
            );
          default:
            return list;
        }
      }),
    ),
    HttpRouter.add(
      "GET",
      "/elsewhere",
      Effect.gen(function* () {
        yield* Ref.update(paths, (all) => [...all, "/elsewhere"]);
        return list;
      }),
    ),
  );
  const services = yield* Layer.build(
    HttpRouter.serve(routes, { disableLogger: true, disableListenLog: true }).pipe(
      Layer.provideMerge(NodeHttpServer.layer(createServer, { host: "127.0.0.1", port: 0 })),
    ),
  ).pipe(Scope.provide(listener));
  const server = yield* HttpServer.HttpServer.pipe(Effect.provideContext(services));
  if (!("port" in server.address)) return yield* Effect.die("Registry fixture must listen on TCP");
  return {
    origin: `http://127.0.0.1:${server.address.port}`,
    paths: Ref.get(paths),
    close: Scope.close(listener, Exit.void),
  };
});
