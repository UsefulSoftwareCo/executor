// Refresh endpoint — covers `sources.refresh(id)` for an OpenAPI
// source added from a URL. Stands up a local HTTP server that serves
// one of two spec versions (swappable mid-test) so we can verify the
// refresh path re-fetches from the stored origin and replaces the
// operation set. Raw-text sources assert the no-op branch.

import { describe, expect, it } from "@effect/vitest";
import { Effect, Ref, Schema } from "effect";
import { HttpServerResponse } from "effect/unstable/http";
import { HttpApi, HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/unstable/httpapi";

import { ScopeId } from "@executor-js/sdk";
import { serveTestHttpApp } from "@executor-js/sdk/testing";

import { asOrg } from "./__test-harness__/api-harness";

const isJsonObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const stripDefaultOperationPrefix = (spec: unknown): unknown => {
  if (!isJsonObject(spec) || !isJsonObject(spec.paths)) return spec;
  for (const pathItem of Object.values(spec.paths)) {
    if (!isJsonObject(pathItem)) continue;
    for (const operation of Object.values(pathItem)) {
      if (!isJsonObject(operation)) continue;
      if (
        typeof operation.operationId === "string" &&
        operation.operationId.startsWith("default.")
      ) {
        operation.operationId = operation.operationId.slice("default.".length);
      }
      if (
        Array.isArray(operation.tags) &&
        operation.tags.length === 1 &&
        operation.tags[0] === "default"
      ) {
        delete operation.tags;
      }
    }
  }
  return spec;
};

const specJsonFromApi = (api: HttpApi.Any): string =>
  JSON.stringify(stripDefaultOperationPrefix(OpenApi.fromApi(api as HttpApi.AnyWithProps)));

const PingEndpoint = HttpApiEndpoint.get("ping", "/ping", { success: Schema.Unknown });
const PongEndpoint = HttpApiEndpoint.get("pong", "/pong", { success: Schema.Unknown });

const RefreshGroupV1 = HttpApiGroup.make("default").add(PingEndpoint);
const RefreshGroupV2 = HttpApiGroup.make("default").add(PingEndpoint).add(PongEndpoint);

const specV1 = specJsonFromApi(
  HttpApi.make("refreshFixture")
    .add(RefreshGroupV1)
    .annotateMerge(OpenApi.annotations({ title: "Refresh Fixture", version: "1.0.0" })),
);

const specV2 = specJsonFromApi(
  HttpApi.make("refreshFixture")
    .add(RefreshGroupV2)
    .annotateMerge(OpenApi.annotations({ title: "Refresh Fixture", version: "2.0.0" })),
);

// Mutable ref: tests flip `current` between v1 and v2 around the
// refresh call. Using a single server keeps the URL stable across
// both addSpec and refresh — the plugin persists the original URL,
// so the second fetch goes back to the same endpoint.
const serveMutableSpec = () =>
  Effect.gen(function* () {
    const current = yield* Ref.make(specV1);
    const requests = yield* Ref.make(0);
    const server = yield* serveTestHttpApp(() =>
      Effect.gen(function* () {
        yield* Ref.update(requests, (count) => count + 1);
        const spec = yield* Ref.get(current);
        return HttpServerResponse.text(spec, {
          status: 200,
          contentType: "application/json",
        });
      }),
    );
    return {
      baseUrl: server.baseUrl,
      setSpec: (s: string) => Ref.set(current, s),
      requestCount: Ref.get(requests),
    };
  });

describe("sources.refresh (HTTP)", () => {
  it.effect("addSpec from URL → canRefresh:true; refresh re-fetches and updates tools", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const server = yield* serveMutableSpec();
        const org = `org_${crypto.randomUUID()}`;
        const namespace = `ns_${crypto.randomUUID().replace(/-/g, "_")}`;

        yield* asOrg(org, (client) =>
          client.openapi.addSpec({
            params: { scopeId: ScopeId.make(org) },
            payload: {
              targetScope: ScopeId.make(org),
              spec: `${server.baseUrl}/spec.json`,
              namespace,
            },
          }),
        );

        const before = yield* asOrg(org, (client) =>
          client.sources.list({ params: { scopeId: ScopeId.make(org) } }),
        );
        const beforeSource = before.find((s) => s.id === namespace);
        expect(beforeSource?.canRefresh).toBe(true);

        const fetchedBefore = yield* asOrg(org, (client) =>
          client.openapi.getSource({
            params: { scopeId: ScopeId.make(org), namespace },
          }),
        );
        expect(fetchedBefore?.config.sourceUrl).toBe(`${server.baseUrl}/spec.json`);

        const beforeTools = yield* asOrg(org, (client) =>
          client.sources.tools({
            params: { scopeId: ScopeId.make(org), sourceId: namespace },
          }),
        );
        expect(beforeTools.length).toBe(1);
        expect(beforeTools.some((t) => t.name.startsWith("ping"))).toBe(true);
        expect(beforeTools.some((t) => t.name.startsWith("pong"))).toBe(false);

        // Flip the remote to v2 (adds `pong`) and trigger refresh.
        yield* server.setSpec(specV2);
        const requestsBefore = yield* server.requestCount;

        const refreshResult = yield* asOrg(org, (client) =>
          client.sources.refresh({
            params: { scopeId: ScopeId.make(org), sourceId: namespace },
          }),
        );
        expect(refreshResult.refreshed).toBe(true);
        expect(yield* server.requestCount).toBeGreaterThan(requestsBefore);

        const afterTools = yield* asOrg(org, (client) =>
          client.sources.tools({
            params: { scopeId: ScopeId.make(org), sourceId: namespace },
          }),
        );
        expect(afterTools.length).toBe(2);
        expect(afterTools.some((t) => t.name.startsWith("ping"))).toBe(true);
        expect(afterTools.some((t) => t.name.startsWith("pong"))).toBe(true);
      }),
    ),
  );

  it.effect("addSpec from raw text → canRefresh:false; refresh is a no-op", () =>
    Effect.gen(function* () {
      const org = `org_${crypto.randomUUID()}`;
      const namespace = `ns_${crypto.randomUUID().replace(/-/g, "_")}`;

      yield* asOrg(org, (client) =>
        client.openapi.addSpec({
          params: { scopeId: ScopeId.make(org) },
          payload: {
            targetScope: ScopeId.make(org),
            spec: specV1,
            namespace,
          },
        }),
      );

      const sources = yield* asOrg(org, (client) =>
        client.sources.list({ params: { scopeId: ScopeId.make(org) } }),
      );
      const row = sources.find((s) => s.id === namespace);
      expect(row?.canRefresh).toBe(false);

      // Raw-text sources reach the plugin with no stored URL and
      // silently no-op — UI gates the action on canRefresh, but the
      // server should not 500 if a caller slips through.
      const result = yield* asOrg(org, (client) =>
        client.sources.refresh({
          params: { scopeId: ScopeId.make(org), sourceId: namespace },
        }),
      );
      expect(result.refreshed).toBe(true);
    }),
  );
});
