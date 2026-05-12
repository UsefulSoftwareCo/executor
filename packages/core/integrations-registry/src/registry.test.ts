import { describe, expect, it } from "@effect/vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Layer, Ref } from "effect";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http";
import { NodeFileSystem } from "@effect/platform-node";

import {
  IntegrationsRegistry,
  buildUserAgent,
  isFetchDisabled,
  layer as integrationsRegistryLayer,
} from "./registry";

const TEST_USER_AGENT = "executor/dev/test/cli";

// Records every outgoing request so tests can assert on URL + headers.
const makeRecordingHttpClient = (
  body: () => string = () => `{}`,
): Effect.Effect<{
  readonly layer: Layer.Layer<HttpClient.HttpClient>;
  readonly requests: Ref.Ref<ReadonlyArray<{ url: string; userAgent: string }>>;
}> =>
  Effect.gen(function* () {
    const requests = yield* Ref.make<ReadonlyArray<{ url: string; userAgent: string }>>([]);
    const layer = Layer.succeed(HttpClient.HttpClient)(
      HttpClient.make((request: HttpClientRequest.HttpClientRequest) =>
        Effect.gen(function* () {
          yield* Ref.update(requests, (xs) => [
            ...xs,
            { url: request.url, userAgent: request.headers["user-agent"] ?? "" },
          ]);
          return HttpClientResponse.fromWeb(
            request,
            new Response(body(), {
              status: 200,
              headers: { "content-type": "application/json" },
            }),
          );
        }),
      ),
    );
    return { layer, requests };
  });

describe("buildUserAgent", () => {
  it("formats executor/<channel>/<version>/<client>", () => {
    expect(buildUserAgent({ channel: "stable", version: "1.2.3", client: "cli" })).toBe(
      "executor/stable/1.2.3/cli",
    );
    expect(buildUserAgent({ channel: "beta", version: "1.2.3-beta.0", client: "local" })).toBe(
      "executor/beta/1.2.3-beta.0/local",
    );
  });

  it("contains the substring 'executor' so the worker filter matches", () => {
    const ua = buildUserAgent({ channel: "dev", version: "0.0.0", client: "cli" });
    expect(ua.includes("executor")).toBe(true);
  });
});

describe("isFetchDisabled", () => {
  it("honors DO_NOT_TRACK", () => {
    expect(isFetchDisabled({ DO_NOT_TRACK: "1" })).toBe(true);
    expect(isFetchDisabled({ DO_NOT_TRACK: "true" })).toBe(true);
    expect(isFetchDisabled({ DO_NOT_TRACK: "0" })).toBe(false);
  });

  it("honors EXECUTOR_DISABLE_INTEGRATIONS_FETCH", () => {
    expect(isFetchDisabled({ EXECUTOR_DISABLE_INTEGRATIONS_FETCH: "1" })).toBe(true);
    expect(isFetchDisabled({ EXECUTOR_DISABLE_INTEGRATIONS_FETCH: "yes" })).toBe(true);
  });

  it("defaults to enabled when neither env var is set", () => {
    expect(isFetchDisabled({})).toBe(false);
  });
});

const withTempCache = <A, E, R>(
  body: (cacheDir: string) => Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> =>
  Effect.acquireUseRelease(
    Effect.promise(() => mkdtemp(join(tmpdir(), "integrations-registry-test-"))),
    body,
    (dir) => Effect.promise(() => rm(dir, { recursive: true, force: true })),
  );

describe("IntegrationsRegistry", () => {
  it.effect("disabled flag short-circuits — no network, empty registry", () =>
    withTempCache((cacheDir) =>
      Effect.gen(function* () {
        const { layer: httpLayer, requests } = yield* makeRecordingHttpClient();

        const program = Effect.gen(function* () {
          const registry = yield* IntegrationsRegistry;
          return yield* registry.get();
        });

        const result = yield* program.pipe(
          Effect.provide(
            integrationsRegistryLayer({
              userAgent: TEST_USER_AGENT,
              disabled: true,
              cacheDir,
            }).pipe(Layer.provide(httpLayer), Layer.provide(NodeFileSystem.layer)),
          ),
        );

        expect(result).toBeUndefined();
        const sent = yield* Ref.get(requests);
        expect(sent).toHaveLength(0);
      }),
    ),
  );

  it.effect("happy path — fetches, parses, sends User-Agent header", () =>
    withTempCache((cacheDir) =>
      Effect.gen(function* () {
        const payload = { providers: { acme: { name: "Acme" } } };
        const { layer: httpLayer, requests } = yield* makeRecordingHttpClient(() =>
          JSON.stringify(payload),
        );

        const program = Effect.gen(function* () {
          const registry = yield* IntegrationsRegistry;
          return yield* registry.get();
        });

        const result = yield* program.pipe(
          Effect.provide(
            integrationsRegistryLayer({
              userAgent: TEST_USER_AGENT,
              cacheDir,
              url: "https://integrations.test/api.json",
            }).pipe(Layer.provide(httpLayer), Layer.provide(NodeFileSystem.layer)),
          ),
        );

        expect(result).toEqual(payload);
        const sent = yield* Ref.get(requests);
        expect(sent).toHaveLength(1);
        expect(sent[0]?.url).toBe("https://integrations.test/api.json");
        expect(sent[0]?.userAgent).toBe(TEST_USER_AGENT);
      }),
    ),
  );

  it.effect("cache hit — second get returns cached value without re-fetching", () =>
    withTempCache((cacheDir) =>
      Effect.gen(function* () {
        const { layer: httpLayer, requests } = yield* makeRecordingHttpClient(() =>
          JSON.stringify({ ok: true }),
        );

        const program = Effect.gen(function* () {
          const registry = yield* IntegrationsRegistry;
          const first = yield* registry.get();
          const second = yield* registry.get();
          return { first, second };
        });

        const { first, second } = yield* program.pipe(
          Effect.provide(
            integrationsRegistryLayer({
              userAgent: TEST_USER_AGENT,
              cacheDir,
              url: "https://integrations.test/api.json",
            }).pipe(Layer.provide(httpLayer), Layer.provide(NodeFileSystem.layer)),
          ),
        );

        expect(first).toEqual({ ok: true });
        expect(second).toEqual({ ok: true });
        const sent = yield* Ref.get(requests);
        // Either 0 (disk hit) or 1 (network), but never 2 — the second
        // `get()` is served by the in-memory cached effect.
        expect(sent.length).toBeLessThanOrEqual(1);
      }),
    ),
  );
});
