/**
 * A synthetic public app registry. It answers a name with the listings published under exactly that
 * name, and fixed names select responses the product must classify. Like Cloud's registry, it
 * serves a listing's source only for the commit the listing selects now.
 */
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import { Deferred, Effect, Exit, Layer, Option, Ref, Scope } from "effect";
import { HttpRouter, HttpServer, HttpServerRequest, HttpServerResponse } from "effect/http";
import { createServer } from "node:http";
import { withApps } from "./apps-release.ts";

/** A listing of an older or custom registry: its name has no dot in its scope. */
export const registryPublication = {
  name: "@fixture/example",
  commit: "a".repeat(40),
  description: "A shared example",
  publishedAt: "2026-01-01T00:00:00.000Z",
};

/** A listing in an organization's publishing scope. Clients released before scopes read `@scoped/notes`. */
export const registryScopedListing = {
  name: "@scoped.executor.community/notes",
  commit: "b".repeat(40),
  description: "Notes in a publishing scope",
  publishedAt: "2026-01-02T00:00:00.000Z",
};
/** Two listings that clients released before publisher scopes would both read as `@twin/notes`. */
export const registryTwinListings = [
  {
    name: "@twin/notes",
    commit: "c".repeat(40),
    description: "Notes without a publishing scope",
    publishedAt: "2026-01-03T00:00:00.000Z",
  },
  {
    name: "@twin.executor.community/notes",
    commit: "d".repeat(40),
    description: "Notes in the same slug's publishing scope",
    publishedAt: "2026-01-04T00:00:00.000Z",
  },
] as const;
/** Every listing the registry publishes, as it lists them. */
export const registryCatalog = [
  registryPublication,
  registryScopedListing,
  ...registryTwinListings,
];

/**
 * A listing in a format no release reads yet: a name outside every package name pattern, as a
 * later widening could send.
 */
export const registryFutureListing = { ...registryPublication, name: "@fixture/future+format" };
/** A listing with a supported name and malformed metadata, which no release reads. */
export const registryMalformedListing = {
  ...registryPublication,
  name: "@fixture/malformed",
  description: 42,
};
/**
 * The name that selects a listing of a readable publication beside {@link registryFutureListing}
 * and {@link registryMalformedListing}.
 */
export const registryMixedName = "@fixture/mixed";

/** Package names that select each upstream behavior. */
export const registryFixtureNames = {
  redirect: "@fixture/moved",
  unavailable: "@fixture/down",
  garbled: "@fixture/garbled",
  missing: "@fixture/missing",
} as const;

type Listing = (typeof registryCatalog)[number];

/** A listing's source: an app that deploys, whose package.json names the listing. */
const listingSource = (listing: Listing) => ({
  publication: listing,
  files: [
    {
      path: "index.ts",
      content: `import { defineApp } from "apps";\nexport default defineApp({}, {});\n`,
    },
    {
      path: "package.json",
      content: JSON.stringify({
        name: listing.name,
        description: listing.description,
        dependencies: withApps(),
      }),
    },
  ],
});
const notFound = HttpServerResponse.jsonUnsafe(
  { _tag: "RegistryError", reason: "not-found" },
  { status: 400 },
);
const changed = HttpServerResponse.jsonUnsafe(
  { _tag: "RegistryError", reason: "changed" },
  { status: 400 },
);

/**
 * Start the registry on loopback. `paths` lists every received request. `close` stops the
 * listener early so later reads cannot connect; the case scope otherwise closes it. `hold` keeps
 * later listing responses pending until `release`; `held` waits until one has arrived. `publish`
 * replaces what the registry publishes, as when a listing is replaced or renamed.
 */
export const registryUpstream = Effect.gen(function* () {
  const listener = yield* Scope.make();
  const gate = yield* Ref.make(
    Option.none<{
      readonly arrived: Deferred.Deferred<void>;
      readonly open: Deferred.Deferred<void>;
    }>(),
  );
  const release = Ref.getAndSet(gate, Option.none()).pipe(
    Effect.flatMap(
      Option.match({
        onNone: () => Effect.void,
        onSome: ({ open }) => Deferred.succeed(open, undefined),
      }),
    ),
    Effect.asVoid,
  );
  yield* Effect.addFinalizer(() => release.pipe(Effect.andThen(Scope.close(listener, Exit.void))));
  const paths = yield* Ref.make<ReadonlyArray<string>>([]);
  const revisions = yield* Ref.make<ReadonlyArray<string | undefined>>([]);
  const catalog = yield* Ref.make<ReadonlyArray<Listing>>(registryCatalog);
  const list = Effect.map(Ref.get(catalog), (listings) => HttpServerResponse.jsonUnsafe(listings));
  const routes = Layer.mergeAll(
    HttpRouter.add(
      "GET",
      "/api/registry/apps",
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest;
        const url = new URL(request.url, "http://registry.invalid");
        yield* Ref.update(paths, (all) => [...all, url.pathname + url.search]);
        yield* Ref.update(revisions, (all) => [...all, request.headers["executor-wire-revision"]]);
        const held = yield* Ref.get(gate);
        if (Option.isSome(held)) {
          yield* Deferred.succeed(held.value.arrived, undefined);
          yield* Deferred.await(held.value.open);
        }
        const name = url.searchParams.get("name");
        switch (name) {
          case registryFixtureNames.redirect:
            // A followed redirect would succeed here, so only a refused redirect fails.
            return HttpServerResponse.empty({ status: 302, headers: { location: "/elsewhere" } });
          case registryFixtureNames.unavailable:
            return HttpServerResponse.text("unavailable", { status: 503 });
          case registryFixtureNames.garbled:
            return HttpServerResponse.html("<html></html>");
          case registryMixedName:
            return HttpServerResponse.jsonUnsafe([
              registryPublication,
              registryFutureListing,
              registryMalformedListing,
            ]);
          case registryFixtureNames.missing:
            return notFound;
          case null:
            return yield* list;
          default:
            return HttpServerResponse.jsonUnsafe(
              (yield* Ref.get(catalog)).filter((listing) => listing.name === name),
            );
        }
      }),
    ),
    HttpRouter.add(
      "GET",
      "/api/registry/source",
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest;
        const url = new URL(request.url, "http://registry.invalid");
        yield* Ref.update(paths, (all) => [...all, url.pathname + url.search]);
        const listing = (yield* Ref.get(catalog)).find(
          (candidate) => candidate.name === url.searchParams.get("name"),
        );
        if (listing === undefined) return notFound;
        return listing.commit === url.searchParams.get("commit")
          ? HttpServerResponse.jsonUnsafe(listingSource(listing))
          : changed;
      }),
    ),
    HttpRouter.add(
      "GET",
      "/elsewhere",
      Effect.gen(function* () {
        yield* Ref.update(paths, (all) => [...all, "/elsewhere"]);
        return yield* list;
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
    /** The wire revision each listing request stated. */
    revisions: Ref.get(revisions),
    hold: Effect.gen(function* () {
      const arrived = yield* Deferred.make<void>();
      const open = yield* Deferred.make<void>();
      yield* Ref.set(gate, Option.some({ arrived, open }));
      return { held: Deferred.await(arrived).pipe(Effect.timeout("20 seconds")) };
    }),
    release,
    publish: (listings: ReadonlyArray<Listing>) => Ref.set(catalog, listings),
    close: Scope.close(listener, Exit.void),
  };
});
