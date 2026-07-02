// ---------------------------------------------------------------------------
// Spec-fetch cache coverage.
//
// The `spec_source` index over the content-addressed blob store is what turns
// the add flow's detect → preview → addSpec sequence into ONE download, and
// updateSpec's re-fetch into a bodyless 304 when the upstream is unchanged.
// These tests pin the observable contract at the HTTP boundary (request and
// 304 counts against a real local server), not the index internals:
//   - within-TTL repeats of previewSpec/addSpec hit the network once,
//   - updateSpec always revalidates (a TTL-fresh entry must not mask an
//     upstream change) and downloads nothing when the server 304s,
//   - a changed upstream busts the cache through the validators,
//   - inline blob specs never touch the network or the URL index.
// ---------------------------------------------------------------------------

import { describe, expect, it } from "@effect/vitest";
import { Effect, Ref, Scope } from "effect";
import {
  FetchHttpClient,
  HttpRouter,
  HttpServerRequest,
  HttpServerResponse,
} from "effect/unstable/http";

import { createExecutor, sha256Hex } from "@executor-js/sdk";
import {
  makeTestConfig,
  memoryCredentialsPlugin,
  serveTestHttpRoutes,
} from "@executor-js/sdk/testing";

import { openApiPlugin } from "./plugin";

const specV1 = JSON.stringify({
  openapi: "3.0.3",
  info: { title: "Cached API", version: "1.0.0" },
  paths: {
    "/ping": {
      get: {
        operationId: "ping",
        summary: "Return a pong",
        responses: { "200": { description: "pong" } },
      },
    },
  },
});

const specV2 = JSON.stringify({
  openapi: "3.0.3",
  info: { title: "Cached API", version: "2.0.0" },
  paths: {
    "/ping": {
      get: {
        operationId: "ping",
        summary: "Return a pong",
        responses: { "200": { description: "pong" } },
      },
    },
    "/widgets": {
      get: {
        operationId: "listWidgets",
        summary: "List widgets",
        responses: { "200": { description: "widgets" } },
      },
    },
  },
});

interface SpecServer {
  readonly specUrl: string;
  readonly setSpec: (body: string) => Effect.Effect<void>;
  /** Requests that reached the server (200s AND 304s). */
  readonly requestCount: Effect.Effect<number>;
  /** Of those, how many were answered 304 Not Modified. */
  readonly notModifiedCount: Effect.Effect<number>;
}

/** A local spec host that serves a strong ETag (the body's SHA-256) and
 *  honors `If-None-Match` with a 304 — the upstream shape the conditional
 *  refresh path is written against. */
const serveEtagSpecServer = (initial: string): Effect.Effect<SpecServer, unknown, Scope.Scope> =>
  Effect.gen(function* () {
    const body = yield* Ref.make(initial);
    const requests = yield* Ref.make(0);
    const notModified = yield* Ref.make(0);
    const server = yield* serveTestHttpRoutes([
      HttpRouter.route(
        "GET",
        "/spec.json",
        Effect.gen(function* () {
          yield* Ref.update(requests, (count) => count + 1);
          const current = yield* Ref.get(body);
          const etag = `"${yield* sha256Hex(current)}"`;
          const request = yield* HttpServerRequest.HttpServerRequest;
          if (request.headers["if-none-match"] === etag) {
            yield* Ref.update(notModified, (count) => count + 1);
            return HttpServerResponse.empty({ status: 304, headers: { etag } });
          }
          return HttpServerResponse.text(current, {
            status: 200,
            contentType: "application/json",
            headers: { etag },
          });
        }),
      ),
    ]);
    return {
      specUrl: server.url("/spec.json"),
      setSpec: (next) => Ref.set(body, next),
      requestCount: Ref.get(requests),
      notModifiedCount: Ref.get(notModified),
    };
  });

// The spec server is a real 127.0.0.1 listener — reach it over the default
// fetch-based client, like production would.
const makeCacheTestExecutor = () =>
  createExecutor(
    makeTestConfig({
      plugins: [
        openApiPlugin({ httpClientLayer: FetchHttpClient.layer }),
        memoryCredentialsPlugin(),
      ] as const,
    }),
  );

describe("OpenAPI spec-fetch cache", () => {
  it.effect("preview → preview → addSpec downloads the spec once", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const server = yield* serveEtagSpecServer(specV1);
        const executor = yield* makeCacheTestExecutor();

        // The add form's debounced analyze fires previewSpec more than once.
        yield* executor.openapi.previewSpec(server.specUrl);
        yield* executor.openapi.previewSpec(server.specUrl);
        const added = yield* executor.openapi.addSpec({
          spec: { kind: "url", url: server.specUrl },
          slug: "cached_api",
        });

        expect(added.toolCount).toBe(1);
        expect(yield* server.requestCount).toBe(1);
      }),
    ),
  );

  it.effect("updateSpec revalidates with the stored ETag and skips the download on 304", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const server = yield* serveEtagSpecServer(specV1);
        const executor = yield* makeCacheTestExecutor();

        yield* executor.openapi.addSpec({
          spec: { kind: "url", url: server.specUrl },
          slug: "cached_api",
        });
        expect(yield* server.requestCount).toBe(1);

        // Unchanged upstream: refresh must still hit the network (revalidate,
        // not trust the TTL) but get a bodyless 304, and the catalog stays.
        const unchanged = yield* executor.openapi.updateSpec("cached_api");
        expect(unchanged.toolCount).toBe(1);
        expect(unchanged.addedTools).toEqual([]);
        expect(unchanged.removedTools).toEqual([]);
        expect(yield* server.requestCount).toBe(2);
        expect(yield* server.notModifiedCount).toBe(1);
      }),
    ),
  );

  it.effect("updateSpec picks up a changed upstream through the validators", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const server = yield* serveEtagSpecServer(specV1);
        const executor = yield* makeCacheTestExecutor();

        yield* executor.openapi.addSpec({
          spec: { kind: "url", url: server.specUrl },
          slug: "cached_api",
        });
        yield* server.setSpec(specV2);

        // Immediately after the add (well within the TTL): the changed spec
        // must still land because refresh revalidates unconditionally.
        const updated = yield* executor.openapi.updateSpec("cached_api");
        expect(updated.toolCount).toBe(2);
        expect(updated.addedTools).toEqual(["widgets.listWidgets"]);
        expect(yield* server.notModifiedCount).toBe(0);

        // And the refreshed entry serves the NEW spec from cache.
        const preview = yield* executor.openapi.previewSpec(server.specUrl);
        expect(preview.operationCount).toBe(2);
        expect(yield* server.requestCount).toBe(2);
      }),
    ),
  );

  it.effect("inline blob specs never touch the network", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const server = yield* serveEtagSpecServer(specV1);
        const executor = yield* makeCacheTestExecutor();

        yield* executor.openapi.previewSpec(specV1);
        yield* executor.openapi.addSpec({
          spec: { kind: "blob", value: specV1 },
          slug: "inline_api",
          baseUrl: "https://api.example.test",
        });

        expect(yield* server.requestCount).toBe(0);
      }),
    ),
  );
});
