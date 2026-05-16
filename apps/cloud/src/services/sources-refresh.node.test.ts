// Refresh endpoint — covers `sources.refresh(id)` for an OpenAPI
// source added from a URL. Stands up a local HTTP server that serves
// one of two spec versions (swappable mid-test) so we can verify the
// refresh path re-fetches from the stored origin and replaces the
// operation set. Raw-text sources assert the no-op branch.

import { describe, expect, it } from "@effect/vitest";
import { Effect, Schema } from "effect";
import { HttpApi, HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/unstable/httpapi";

import { ScopeId } from "@executor-js/sdk";
import {
  makeOpenApiHttpApiTestSpecPayload,
  serveMutableOpenApiSpecTestServer,
} from "@executor-js/plugin-openapi/testing";

import { asOrg } from "./__test-harness__/api-harness";

const PingEndpoint = HttpApiEndpoint.get("ping", "/ping", { success: Schema.Unknown });
const PongEndpoint = HttpApiEndpoint.get("pong", "/pong", { success: Schema.Unknown });

const RefreshGroupV1 = HttpApiGroup.make("default", { topLevel: true }).add(PingEndpoint);
const RefreshGroupV2 = HttpApiGroup.make("default", { topLevel: true })
  .add(PingEndpoint)
  .add(PongEndpoint);

const refreshApi = (version: "1.0.0" | "2.0.0") =>
  HttpApi.make("refreshFixture")
    .add(version === "1.0.0" ? RefreshGroupV1 : RefreshGroupV2)
    .annotateMerge(OpenApi.annotations({ title: "Refresh Fixture", version }));

const makeRefreshSpecText = () => makeOpenApiHttpApiTestSpecPayload(refreshApi("1.0.0")).spec;

describe("sources.refresh (HTTP)", () => {
  it.effect("addSpec from URL → canRefresh:true; refresh re-fetches and updates tools", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const server = yield* serveMutableOpenApiSpecTestServer({
          initialApi: refreshApi("1.0.0"),
        });
        const org = `org_${crypto.randomUUID()}`;
        const namespace = `ns_${crypto.randomUUID().replace(/-/g, "_")}`;

        yield* asOrg(org, (client) =>
          client.openapi.addSpec({
            params: { scopeId: ScopeId.make(org) },
            payload: {
              targetScope: ScopeId.make(org),
              spec: server.specUrl,
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
        expect(fetchedBefore?.config.sourceUrl).toBe(server.specUrl);

        const beforeTools = yield* asOrg(org, (client) =>
          client.sources.tools({
            params: { scopeId: ScopeId.make(org), sourceId: namespace },
          }),
        );
        expect(beforeTools.length).toBe(1);
        expect(beforeTools.some((t) => t.id.endsWith(".default.ping"))).toBe(true);
        expect(beforeTools.some((t) => t.id.endsWith(".default.pong"))).toBe(false);

        // Flip the remote to v2 (adds `pong`) and trigger refresh.
        yield* server.setApi(refreshApi("2.0.0"));
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
        expect(afterTools.some((t) => t.id.endsWith(".default.ping"))).toBe(true);
        expect(afterTools.some((t) => t.id.endsWith(".default.pong"))).toBe(true);
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
            spec: makeRefreshSpecText(),
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
