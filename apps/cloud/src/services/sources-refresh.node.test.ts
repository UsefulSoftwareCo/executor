// Refresh endpoint — covers `sources.refresh(id)` for an OpenAPI
// source added from a URL. Stands up a local HTTP server that serves
// one of two spec versions (swappable mid-test) so we can verify the
// refresh path re-fetches from the stored origin and replaces the
// operation set. Raw-text sources assert the no-op branch.

import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";
import http from "node:http";
import { AddressInfo } from "node:net";

import { ScopeId } from "@executor-js/sdk";

import { asOrg } from "./__test-harness__/api-harness";

const specV1 = JSON.stringify({
  openapi: "3.0.0",
  info: { title: "Refresh Fixture", version: "1.0.0" },
  paths: {
    "/ping": {
      get: {
        operationId: "ping",
        summary: "ping",
        responses: { "200": { description: "ok" } },
      },
    },
  },
});

const specV2 = JSON.stringify({
  openapi: "3.0.0",
  info: { title: "Refresh Fixture", version: "2.0.0" },
  paths: {
    "/ping": {
      get: {
        operationId: "ping",
        summary: "ping",
        responses: { "200": { description: "ok" } },
      },
    },
    "/pong": {
      get: {
        operationId: "pong",
        summary: "pong",
        responses: { "200": { description: "ok" } },
      },
    },
  },
});

// Mutable ref: tests flip `current` between v1 and v2 around the
// refresh call. Using a single server keeps the URL stable across
// both addSpec and refresh — the plugin persists the original URL,
// so the second fetch goes back to the same endpoint.
const serveMutableSpec = () => {
  const state = { current: specV1, requests: 0 };
  const server = http.createServer((req, res) => {
    state.requests++;
    res.writeHead(200, { "content-type": "application/json" });
    res.end(state.current);
  });
  return new Promise<{
    baseUrl: string;
    setSpec: (s: string) => void;
    requestCount: () => number;
    close: () => Promise<void>;
  }>((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      resolve({
        baseUrl: `http://127.0.0.1:${port}`,
        setSpec: (s) => {
          state.current = s;
        },
        requestCount: () => state.requests,
        close: () =>
          new Promise((r) => {
            server.close(() => r());
          }),
      });
    });
  });
};

describe("sources.refresh (HTTP)", () => {
  it.effect("addSpec from URL → canRefresh:true; refresh re-fetches and updates tools", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const server = yield* Effect.acquireRelease(
          Effect.promise(() => serveMutableSpec()),
          (server) => Effect.promise(() => server.close()),
        );
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
        server.setSpec(specV2);
        const requestsBefore = server.requestCount();

        const refreshResult = yield* asOrg(org, (client) =>
          client.sources.refresh({
            params: { scopeId: ScopeId.make(org), sourceId: namespace },
          }),
        );
        expect(refreshResult.refreshed).toBe(true);
        expect(server.requestCount()).toBeGreaterThan(requestsBefore);

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
