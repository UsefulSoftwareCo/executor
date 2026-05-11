// Tenant isolation integration test. Runs in plain node (not workerd)
// via vitest.node.config.ts — workerd's dev-mode compile stack crashes
// on the full cloud module graph.

import { describe, expect, it } from "@effect/vitest";
import { Effect, Result } from "effect";

import { ConnectionId, ScopeId, SecretId } from "@executor-js/sdk";

import { asOrg } from "./__test-harness__/api-harness";

const MINIMAL_OPENAPI_SPEC = JSON.stringify({
  openapi: "3.0.0",
  info: { title: "Tenant Test API", version: "1.0.0" },
  paths: {
    "/ping": {
      get: {
        operationId: "ping",
        responses: { "200": { description: "ok" } },
      },
    },
  },
});

describe("tenant isolation (HTTP)", () => {
  it.effect("write requests cannot target another org scope", () =>
    Effect.gen(function* () {
      const orgA = `org_${crypto.randomUUID()}`;
      const orgB = `org_${crypto.randomUUID()}`;

      const result = yield* asOrg(orgB, (client) =>
        client.secrets.set({
          params: { scopeId: ScopeId.make(orgA) },
          payload: {
            id: SecretId.make("planted"),
            name: "planted-by-org-b",
            value: "should-be-rejected",
          },
        }),
      ).pipe(Effect.result);

      expect(Result.isFailure(result)).toBe(true);

      const orgASecrets = yield* asOrg(orgA, (client) =>
        client.secrets.list({ params: { scopeId: ScopeId.make(orgA) } }),
      );
      expect(orgASecrets.map((s) => s.id)).not.toContain("planted");
    }),
  );

  it.effect("read requests with another org scope still use the caller stack", () =>
    Effect.gen(function* () {
      const orgA = `org_${crypto.randomUUID()}`;
      const orgB = `org_${crypto.randomUUID()}`;
      const idA = `sec_a_${crypto.randomUUID().slice(0, 8)}`;

      yield* asOrg(orgA, (client) =>
        client.secrets.set({
          params: { scopeId: ScopeId.make(orgA) },
          payload: { id: SecretId.make(idA), name: "org-a only", value: "v" },
        }),
      );

      const result = yield* asOrg(orgB, (client) =>
        client.secrets.list({ params: { scopeId: ScopeId.make(orgA) } }),
      );
      expect(result.map((s) => s.id)).not.toContain(idA);
    }),
  );

  it.effect("delete requests cannot remove another org secret", () =>
    Effect.gen(function* () {
      const orgA = `org_${crypto.randomUUID()}`;
      const orgB = `org_${crypto.randomUUID()}`;
      const idA = `sec_a_${crypto.randomUUID().slice(0, 8)}`;

      yield* asOrg(orgA, (client) =>
        client.secrets.set({
          params: { scopeId: ScopeId.make(orgA) },
          payload: { id: SecretId.make(idA), name: "org-a only", value: "v" },
        }),
      );

      yield* asOrg(orgB, (client) =>
        client.secrets.remove({
          params: { scopeId: ScopeId.make(orgA), secretId: SecretId.make(idA) },
        }),
      ).pipe(Effect.result);

      const status = yield* asOrg(orgA, (client) =>
        client.secrets.status({
          params: { scopeId: ScopeId.make(orgA), secretId: SecretId.make(idA) },
        }),
      );
      expect(status.status).toBe("resolved");
    }),
  );

  it.effect("sources.list is scoped to the caller org", () =>
    Effect.gen(function* () {
      const orgA = `org_${crypto.randomUUID()}`;
      const orgB = `org_${crypto.randomUUID()}`;
      const namespaceA = `a_${crypto.randomUUID().replace(/-/g, "_")}`;

      yield* asOrg(orgA, (client) =>
        client.openapi.addSpec({
          params: { scopeId: ScopeId.make(orgA) },
          payload: {
            targetScope: ScopeId.make(orgA),
            spec: MINIMAL_OPENAPI_SPEC,
            namespace: namespaceA,
          },
        }),
      );

      const orgBSources = yield* asOrg(orgB, (client) =>
        client.sources.list({ params: { scopeId: ScopeId.make(orgB) } }),
      );
      expect(orgBSources.map((s) => s.id)).not.toContain(namespaceA);
    }),
  );

  it.effect("tools.list is scoped to the caller org", () =>
    Effect.gen(function* () {
      const orgA = `org_${crypto.randomUUID()}`;
      const orgB = `org_${crypto.randomUUID()}`;
      const namespaceA = `a_${crypto.randomUUID().replace(/-/g, "_")}`;

      yield* asOrg(orgA, (client) =>
        client.openapi.addSpec({
          params: { scopeId: ScopeId.make(orgA) },
          payload: {
            targetScope: ScopeId.make(orgA),
            spec: MINIMAL_OPENAPI_SPEC,
            namespace: namespaceA,
          },
        }),
      );

      const orgBTools = yield* asOrg(orgB, (client) =>
        client.tools.list({ params: { scopeId: ScopeId.make(orgB) } }),
      );
      expect(orgBTools.map((t) => t.sourceId)).not.toContain(namespaceA);
      for (const id of orgBTools.map((t) => t.id)) {
        expect(id).not.toContain(namespaceA);
      }
    }),
  );

  it.effect("openapi.getSource cannot reach another org's source by namespace", () =>
    Effect.gen(function* () {
      const orgA = `org_${crypto.randomUUID()}`;
      const orgB = `org_${crypto.randomUUID()}`;
      const namespaceA = `a_${crypto.randomUUID().replace(/-/g, "_")}`;

      yield* asOrg(orgA, (client) =>
        client.openapi.addSpec({
          params: { scopeId: ScopeId.make(orgA) },
          payload: {
            targetScope: ScopeId.make(orgA),
            spec: MINIMAL_OPENAPI_SPEC,
            namespace: namespaceA,
          },
        }),
      );

      const source = yield* asOrg(orgB, (client) =>
        client.openapi.getSource({
          params: { scopeId: ScopeId.make(orgB), namespace: namespaceA },
        }),
      );

      expect(source).toBeNull();
    }),
  );

  it.effect("secrets.list is scoped to the caller org", () =>
    Effect.gen(function* () {
      const orgA = `org_${crypto.randomUUID()}`;
      const orgB = `org_${crypto.randomUUID()}`;
      const secretIdA = `sec_a_${crypto.randomUUID().slice(0, 8)}`;

      yield* asOrg(orgA, (client) =>
        client.secrets.set({
          params: { scopeId: ScopeId.make(orgA) },
          payload: { id: SecretId.make(secretIdA), name: "org-a only", value: "super-secret-a" },
        }),
      );

      const orgBSecrets = yield* asOrg(orgB, (client) =>
        client.secrets.list({ params: { scopeId: ScopeId.make(orgB) } }),
      );
      expect(orgBSecrets.map((s) => s.id)).not.toContain(secretIdA);
    }),
  );

  it.effect("secrets.status reports another org's secret as missing", () =>
    Effect.gen(function* () {
      const orgA = `org_${crypto.randomUUID()}`;
      const orgB = `org_${crypto.randomUUID()}`;
      const secretIdA = `sec_a_${crypto.randomUUID().slice(0, 8)}`;

      yield* asOrg(orgA, (client) =>
        client.secrets.set({
          params: { scopeId: ScopeId.make(orgA) },
          payload: { id: SecretId.make(secretIdA), name: "org-a only", value: "super-secret-a" },
        }),
      );

      const status = yield* asOrg(orgB, (client) =>
        client.secrets.status({
          params: { scopeId: ScopeId.make(orgB), secretId: SecretId.make(secretIdA) },
        }),
      );

      expect(status.status).toBe("missing");
    }),
  );

  it.effect("secret metadata is not visible across orgs", () =>
    Effect.gen(function* () {
      const orgA = `org_${crypto.randomUUID()}`;
      const orgB = `org_${crypto.randomUUID()}`;
      const secretIdA = `sec_a_${crypto.randomUUID().slice(0, 8)}`;

      yield* asOrg(orgA, (client) =>
        client.secrets.set({
          params: { scopeId: ScopeId.make(orgA) },
          payload: { id: SecretId.make(secretIdA), name: "org-a only", value: "super-secret-a" },
        }),
      );

      const status = yield* asOrg(orgB, (client) =>
        client.secrets.status({
          params: { scopeId: ScopeId.make(orgB), secretId: SecretId.make(secretIdA) },
        }),
      );
      const list = yield* asOrg(orgB, (client) =>
        client.secrets.list({ params: { scopeId: ScopeId.make(orgB) } }),
      );

      expect(status.status).toBe("missing");
      expect(list.map((s) => s.id)).not.toContain(secretIdA);
    }),
  );

  it.effect("secret usages are scoped to the caller stack", () =>
    Effect.gen(function* () {
      const orgA = `org_${crypto.randomUUID()}`;
      const orgB = `org_${crypto.randomUUID()}`;
      const namespaceA = `a_${crypto.randomUUID().replace(/-/g, "_")}`;
      const secretIdA = SecretId.make(`sec_a_${crypto.randomUUID().slice(0, 8)}`);

      yield* asOrg(orgA, (client) =>
        Effect.gen(function* () {
          yield* client.secrets.set({
            params: { scopeId: ScopeId.make(orgA) },
            payload: { id: secretIdA, name: "org-a token", value: "v" },
          });
          yield* client.openapi.addSpec({
            params: { scopeId: ScopeId.make(orgA) },
            payload: {
              targetScope: ScopeId.make(orgA),
              spec: MINIMAL_OPENAPI_SPEC,
              namespace: namespaceA,
              headers: {
                Authorization: {
                  kind: "binding",
                  slot: "auth:token",
                  prefix: "Bearer ",
                },
              },
            },
          });
          yield* client.openapi.setSourceBinding({
            params: { scopeId: ScopeId.make(orgA) },
            payload: {
              sourceId: namespaceA,
              sourceScope: ScopeId.make(orgA),
              scope: ScopeId.make(orgA),
              slot: "auth:token",
              value: { kind: "secret", secretId: secretIdA },
            },
          });
        }),
      );

      const usages = yield* asOrg(orgB, (client) =>
        client.secrets.usages({
          params: { scopeId: ScopeId.make(orgB), secretId: secretIdA },
        }),
      );

      expect(usages).toEqual([]);
    }),
  );

  it.effect("connection usages are scoped to the caller stack", () =>
    Effect.gen(function* () {
      const orgA = `org_${crypto.randomUUID()}`;
      const orgB = `org_${crypto.randomUUID()}`;
      const namespaceA = `a_${crypto.randomUUID().replace(/-/g, "_")}`;
      const connectionIdA = ConnectionId.make(`conn_a_${crypto.randomUUID().slice(0, 8)}`);

      yield* asOrg(orgA, (client) =>
        Effect.gen(function* () {
          yield* client.openapi.addSpec({
            params: { scopeId: ScopeId.make(orgA) },
            payload: {
              targetScope: ScopeId.make(orgA),
              spec: MINIMAL_OPENAPI_SPEC,
              namespace: namespaceA,
              headers: {
                Authorization: {
                  kind: "binding",
                  slot: "auth:conn",
                  prefix: "Bearer ",
                },
              },
            },
          });
          yield* client.openapi.setSourceBinding({
            params: { scopeId: ScopeId.make(orgA) },
            payload: {
              sourceId: namespaceA,
              sourceScope: ScopeId.make(orgA),
              scope: ScopeId.make(orgA),
              slot: "auth:conn",
              value: { kind: "connection", connectionId: connectionIdA },
            },
          });
        }),
      ).pipe(Effect.result);

      const usages = yield* asOrg(orgB, (client) =>
        client.connections.usages({
          params: { scopeId: ScopeId.make(orgB), connectionId: connectionIdA },
        }),
      );

      expect(usages).toEqual([]);
    }),
  );

  it.effect("updating a same-namespace OpenAPI source in one org does not mutate another org", () =>
    Effect.gen(function* () {
      const orgA = `org_${crypto.randomUUID()}`;
      const orgB = `org_${crypto.randomUUID()}`;
      const namespace = `shared_${crypto.randomUUID().replace(/-/g, "_")}`;

      yield* asOrg(orgA, (client) =>
        client.openapi.addSpec({
          params: { scopeId: ScopeId.make(orgA) },
          payload: {
            targetScope: ScopeId.make(orgA),
            spec: MINIMAL_OPENAPI_SPEC,
            namespace,
            name: "Org A API",
            baseUrl: "https://org-a.example.com",
          },
        }),
      );
      yield* asOrg(orgB, (client) =>
        client.openapi.addSpec({
          params: { scopeId: ScopeId.make(orgB) },
          payload: {
            targetScope: ScopeId.make(orgB),
            spec: MINIMAL_OPENAPI_SPEC,
            namespace,
            name: "Org B API",
            baseUrl: "https://org-b.example.com",
          },
        }),
      );

      yield* asOrg(orgA, (client) =>
        client.openapi.updateSource({
          params: { scopeId: ScopeId.make(orgA), namespace },
          payload: {
            sourceScope: ScopeId.make(orgA),
            name: "Org A Updated API",
            baseUrl: "https://org-a-updated.example.com",
          },
        }),
      );

      const orgASource = yield* asOrg(orgA, (client) =>
        client.openapi.getSource({ params: { scopeId: ScopeId.make(orgA), namespace } }),
      );
      const orgBSource = yield* asOrg(orgB, (client) =>
        client.openapi.getSource({ params: { scopeId: ScopeId.make(orgB), namespace } }),
      );
      expect(orgASource?.name).toBe("Org A Updated API");
      expect(orgASource?.config.baseUrl).toBe("https://org-a-updated.example.com");
      expect(orgBSource?.name).toBe("Org B API");
      expect(orgBSource?.config.baseUrl).toBe("https://org-b.example.com");
    }),
  );
});
