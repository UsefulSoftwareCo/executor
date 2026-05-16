// Source endpoints — CRUD through HttpApiClient. Complements tenant
// isolation tests by exercising add → get → update → remove flows and
// the error paths (remove non-existent, remove static, etc.) within a
// single org.

import { describe, expect, it } from "@effect/vitest";
import { Effect, Result, Schema } from "effect";
import { HttpApi, HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/unstable/httpapi";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { ScopeId, SecretId } from "@executor-js/sdk";
import {
  serveGraphqlTestServer,
  makeGreetingGraphqlSchema,
} from "@executor-js/plugin-graphql/testing";
import { makeGreetingMcpServer, serveMcpServer } from "@executor-js/plugin-mcp/testing";
import {
  makeOpenApiHttpApiTestAddSpecPayload,
  makeOpenApiHttpApiTestSpecPayload,
  serveOpenApiEchoTestServer,
} from "@executor-js/plugin-openapi/testing";

import { asOrg, asUser, testUserOrgScopeId } from "./__test-harness__/api-harness";

const isJsonObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const PingGroup = HttpApiGroup.make("default", { topLevel: true }).add(
  HttpApiEndpoint.get("ping", "/ping", { success: Schema.Unknown }),
);

const MinimalSourceApi = HttpApi.make("sourcesApiTest")
  .add(PingGroup)
  .annotateMerge(OpenApi.annotations({ title: "Sources API Test", version: "1.0.0" }));

const makeMinimalOpenApiSourcePayload = (
  targetScope: ScopeId,
  namespace: string,
  options: Omit<
    Parameters<typeof makeOpenApiHttpApiTestAddSpecPayload>[1],
    "targetScope" | "namespace"
  > = {},
) =>
  makeOpenApiHttpApiTestAddSpecPayload(MinimalSourceApi, {
    targetScope,
    namespace,
    ...options,
  });

const makeMinimalOpenApiPreviewPayload = () => makeOpenApiHttpApiTestSpecPayload(MinimalSourceApi);

// The Cloudflare OpenAPI spec is the biggest real spec we care about:
// 16MB, 2700+ operations, thousands of shared schemas. Exercising
// addSpec end-to-end on it through the real Drizzle/FumaDB path is the
// load-bearing check that any storage regression (per-row `createMany`,
// accidental N+1 reads, transaction snapshots that copy too much) will show up
// as a test failure instead of a prod incident.
const CLOUDFLARE_SPEC_PATH = resolve(
  __dirname,
  "../../../../packages/plugins/openapi/fixtures/cloudflare.json",
);
const CLOUDFLARE_SPEC = readFileSync(CLOUDFLARE_SPEC_PATH, "utf-8");

describe("sources api (HTTP)", () => {
  it.effect("addSpec → sources.list includes the new namespace", () =>
    Effect.gen(function* () {
      const org = `org_${crypto.randomUUID()}`;
      const namespace = `ns_${crypto.randomUUID().replace(/-/g, "_")}`;

      yield* asOrg(org, (client) =>
        Effect.gen(function* () {
          const result = yield* client.openapi.addSpec({
            params: { scopeId: ScopeId.make(org) },
            payload: makeMinimalOpenApiSourcePayload(ScopeId.make(org), namespace),
          });
          expect(result.namespace).toBe(namespace);
          expect(result.toolCount).toBeGreaterThan(0);
        }),
      );

      const sources = yield* asOrg(org, (client) =>
        client.sources.list({ params: { scopeId: ScopeId.make(org) } }),
      );
      expect(sources.map((s) => s.id)).toContain(namespace);
    }),
  );

  it.effect("openapi.getSource returns the stored source after addSpec", () =>
    Effect.gen(function* () {
      const org = `org_${crypto.randomUUID()}`;
      const namespace = `ns_${crypto.randomUUID().replace(/-/g, "_")}`;

      yield* asOrg(org, (client) =>
        client.openapi.addSpec({
          params: { scopeId: ScopeId.make(org) },
          payload: makeMinimalOpenApiSourcePayload(ScopeId.make(org), namespace),
        }),
      );

      const fetched = yield* asOrg(org, (client) =>
        client.openapi.getSource({ params: { scopeId: ScopeId.make(org), namespace } }),
      );
      expect(fetched).not.toBeNull();
      expect(fetched?.namespace).toBe(namespace);
    }),
  );

  it.effect("openapi.previewSpec returns class-backed preview metadata over HTTP", () =>
    Effect.gen(function* () {
      const org = `org_${crypto.randomUUID()}`;
      const preview = yield* asOrg(org, (client) =>
        client.openapi.previewSpec({
          params: { scopeId: ScopeId.make(org) },
          payload: makeMinimalOpenApiPreviewPayload(),
        }),
      );

      expect(preview).toMatchObject({
        operationCount: 1,
        operations: [
          expect.objectContaining({
            operationId: "ping",
            method: "get",
            path: "/ping",
          }),
        ],
      });
    }),
  );

  it.effect("openapi.addSpec accepts a public HTTP baseUrl in local mode", () =>
    Effect.gen(function* () {
      const org = `org_${crypto.randomUUID()}`;

      const result = yield* asOrg(org, (client) =>
        client.openapi.addSpec({
          params: { scopeId: ScopeId.make(org) },
          payload: makeMinimalOpenApiSourcePayload(
            ScopeId.make(org),
            `ns_${crypto.randomUUID().replace(/-/g, "_")}`,
            { baseUrl: "http://example.com" },
          ),
        }),
      );

      expect(result.toolCount).toBe(1);
    }),
  );

  it.effect("added OpenAPI source can be listed, inspected, and invoked through execution", () =>
    Effect.gen(function* () {
      const server = yield* serveOpenApiEchoTestServer({
        transformSpec: (spec) => ({
          ...spec,
          info: { title: "Invocable Source API", version: "1.0.0" },
          paths: {
            "/echo/{message}": isJsonObject(spec.paths) ? spec.paths["/echo/{message}"] : {},
          },
        }),
      });
      const org = `org_${crypto.randomUUID()}`;
      const namespace = `ns_${crypto.randomUUID().replace(/-/g, "_")}`;
      const scopeId = ScopeId.make(org);

      const addResult = yield* asOrg(org, (client) =>
        client.openapi.addSpec({
          params: { scopeId },
          payload: {
            targetScope: scopeId,
            spec: server.specJson,
            namespace,
          },
        }),
      );
      expect(addResult).toEqual({ namespace, toolCount: 1 });

      const fetched = yield* asOrg(org, (client) =>
        client.openapi.getSource({ params: { scopeId, namespace } }),
      );
      expect(fetched).toMatchObject({
        namespace,
        name: "Invocable Source API",
        config: { baseUrl: server.baseUrl },
      });

      const tools = yield* asOrg(org, (client) =>
        client.sources.tools({ params: { scopeId, sourceId: namespace } }),
      );
      const toolId = `${namespace}.echo.echoMessage`;
      expect(tools.map((tool) => tool.id)).toContain(toolId);

      const execution = yield* asOrg(org, (client) =>
        client.executions.execute({
          payload: {
            code: [
              `const result = await tools.${namespace}.echo.echoMessage({ message: "hello", suffix: "world" });`,
              "return result;",
            ].join("\n"),
          },
        }),
      );

      expect(execution.status).toBe("completed");
      if (execution.status !== "completed") return;
      expect(execution.isError).toBe(false);
      expect(execution.structured).toMatchObject({
        status: "completed",
        result: {
          message: "hello",
          suffix: "world",
          path: "/echo/hello",
        },
        logs: [],
      });
      expect(yield* server.requests).toContainEqual(
        expect.objectContaining({ path: "/echo/hello" }),
      );
    }),
  );

  it.effect("mcp.getSource returns a persisted source even when discovery failed", () =>
    Effect.gen(function* () {
      const org = `org_${crypto.randomUUID()}`;
      const namespace = `mcp_${crypto.randomUUID().replace(/-/g, "_")}`;
      const scopeId = ScopeId.make(org);

      const addResult = yield* asOrg(org, (client) =>
        client.mcp
          .addSource({
            params: { scopeId },
            payload: {
              targetScope: scopeId,
              transport: "remote",
              name: "Broken MCP",
              endpoint: "http://127.0.0.1:1/mcp",
              remoteTransport: "auto",
              namespace,
            },
          })
          .pipe(Effect.result),
      );
      expect(Result.isFailure(addResult)).toBe(true);

      const fetched = yield* asOrg(org, (client) =>
        client.mcp.getSource({ params: { scopeId, namespace } }),
      );
      expect(fetched).toMatchObject({
        namespace,
        name: "Broken MCP",
        config: {
          transport: "remote",
          endpoint: "http://127.0.0.1:1/mcp",
          remoteTransport: "auto",
        },
      });

      const tools = yield* asOrg(org, (client) =>
        client.sources.tools({ params: { scopeId, sourceId: namespace } }),
      );
      expect(tools).toEqual([]);
    }),
  );

  it.effect("added GraphQL source can be inspected and invoked through execution", () =>
    Effect.gen(function* () {
      const server = yield* serveGraphqlTestServer({
        schema: makeGreetingGraphqlSchema({ includeMutation: false }),
      });
      const org = `org_${crypto.randomUUID()}`;
      const namespace = `gql_${crypto.randomUUID().replace(/-/g, "_")}`;
      const scopeId = ScopeId.make(org);

      const added = yield* asOrg(org, (client) =>
        client.graphql.addSource({
          params: { scopeId },
          payload: {
            targetScope: scopeId,
            endpoint: server.endpoint,
            namespace,
            name: "Cloud GraphQL",
          },
        }),
      );
      expect(added).toEqual({ namespace, toolCount: 1 });

      const fetched = yield* asOrg(org, (client) =>
        client.graphql.getSource({ params: { scopeId, namespace } }),
      );
      expect(fetched).toMatchObject({
        namespace,
        name: "Cloud GraphQL",
        endpoint: server.endpoint,
      });

      const tools = yield* asOrg(org, (client) =>
        client.sources.tools({ params: { scopeId, sourceId: namespace } }),
      );
      const toolId = `${namespace}.query.hello`;
      expect(tools.map((tool) => tool.id)).toContain(toolId);

      const execution = yield* asOrg(org, (client) =>
        client.executions.execute({
          payload: {
            code: [
              `const result = await tools.${namespace}.query.hello({ name: "Ada" });`,
              "return result;",
            ].join("\n"),
          },
        }),
      );

      expect(execution.status).toBe("completed");
      if (execution.status !== "completed") return;
      expect(execution.isError).toBe(false);
      expect(execution.structured).toMatchObject({
        status: "completed",
        result: { hello: "Hello Ada" },
      });
      const requests = yield* server.requests;
      expect(requests.some((request) => request.payload.query?.includes("__schema"))).toBe(true);
      expect(requests).toContainEqual(
        expect.objectContaining({
          payload: expect.objectContaining({ variables: { name: "Ada" } }),
        }),
      );
    }),
  );

  it.effect("added MCP source can be inspected and invoked through execution", () =>
    Effect.gen(function* () {
      const server = yield* serveMcpServer(() =>
        makeGreetingMcpServer({
          name: "cloud-e2e-mcp",
          toolDescription: "Echoes from the cloud e2e MCP server",
          text: "cloud-mcp-ok",
        }),
      );
      const org = `org_${crypto.randomUUID()}`;
      const namespace = `mcp_${crypto.randomUUID().replace(/-/g, "_")}`;
      const scopeId = ScopeId.make(org);

      const added = yield* asOrg(org, (client) =>
        client.mcp.addSource({
          params: { scopeId },
          payload: {
            targetScope: scopeId,
            transport: "remote",
            name: "Cloud MCP",
            endpoint: server.endpoint,
            remoteTransport: "streamable-http",
            namespace,
          },
        }),
      );
      expect(added).toEqual({ namespace, toolCount: 1 });

      const fetched = yield* asOrg(org, (client) =>
        client.mcp.getSource({ params: { scopeId, namespace } }),
      );
      expect(fetched).toMatchObject({
        namespace,
        name: "Cloud MCP",
        config: {
          transport: "remote",
          endpoint: server.endpoint,
          remoteTransport: "streamable-http",
        },
      });

      const tools = yield* asOrg(org, (client) =>
        client.sources.tools({ params: { scopeId, sourceId: namespace } }),
      );
      const toolId = `${namespace}.simple_echo`;
      expect(tools.map((tool) => tool.id)).toContain(toolId);

      const execution = yield* asOrg(org, (client) =>
        client.executions.execute({
          payload: {
            code: [
              `const result = await tools.${namespace}.simple_echo({});`,
              "return result;",
            ].join("\n"),
          },
        }),
      );

      expect(execution.status).toBe("completed");
      if (execution.status !== "completed") return;
      expect(execution.isError).toBe(false);
      expect(execution.structured).toMatchObject({
        status: "completed",
        result: {
          content: [{ type: "text", text: "cloud-mcp-ok" }],
        },
      });
      expect((yield* server.requests).length).toBeGreaterThanOrEqual(2);
    }),
  );

  it.effect("sources.remove deletes the source and it drops off sources.list", () =>
    Effect.gen(function* () {
      const org = `org_${crypto.randomUUID()}`;
      const namespace = `ns_${crypto.randomUUID().replace(/-/g, "_")}`;

      yield* asOrg(org, (client) =>
        Effect.gen(function* () {
          yield* client.openapi.addSpec({
            params: { scopeId: ScopeId.make(org) },
            payload: makeMinimalOpenApiSourcePayload(ScopeId.make(org), namespace),
          });
          yield* client.sources.remove({
            params: { scopeId: ScopeId.make(org), sourceId: namespace },
          });
        }),
      );

      const after = yield* asOrg(org, (client) =>
        client.sources.list({ params: { scopeId: ScopeId.make(org) } }),
      );
      expect(after.map((s) => s.id)).not.toContain(namespace);
    }),
  );

  it.effect("sources.remove on a non-existent sourceId is a no-op (idempotent)", () =>
    Effect.gen(function* () {
      const org = `org_${crypto.randomUUID()}`;
      const ghost = `missing_${crypto.randomUUID().slice(0, 8)}`;

      const result = yield* asOrg(org, (client) =>
        client.sources
          .remove({ params: { scopeId: ScopeId.make(org), sourceId: ghost } })
          .pipe(Effect.result),
      );
      expect(Result.isSuccess(result)).toBe(true);
    }),
  );

  it.effect("sources.remove on a static source is rejected", () =>
    Effect.gen(function* () {
      // `canRemove: false` is reserved for static (plugin-declared)
      // sources. Plugin-owned executor tools are mounted under the
      // built-in executor source.
      const org = `org_${crypto.randomUUID()}`;

      const result = yield* asOrg(org, (client) =>
        client.sources
          .remove({ params: { scopeId: ScopeId.make(org), sourceId: "executor" } })
          .pipe(Effect.result),
      );
      expect(Result.isFailure(result)).toBe(true);
    }),
  );

  it.effect("openapi.updateSource round-trips baseUrl + name changes", () =>
    Effect.gen(function* () {
      const org = `org_${crypto.randomUUID()}`;
      const namespace = `ns_${crypto.randomUUID().replace(/-/g, "_")}`;

      yield* asOrg(org, (client) =>
        Effect.gen(function* () {
          yield* client.openapi.addSpec({
            params: { scopeId: ScopeId.make(org) },
            payload: makeMinimalOpenApiSourcePayload(ScopeId.make(org), namespace),
          });
          yield* client.openapi.updateSource({
            params: { scopeId: ScopeId.make(org), namespace },
            payload: {
              sourceScope: ScopeId.make(org),
              name: "Renamed API",
              baseUrl: "https://override.example.com",
            },
          });
        }),
      );

      const fetched = yield* asOrg(org, (client) =>
        client.openapi.getSource({ params: { scopeId: ScopeId.make(org), namespace } }),
      );
      expect(fetched?.name).toBe("Renamed API");
      expect(fetched?.config.baseUrl).toBe("https://override.example.com");
    }),
  );

  it.effect("per-user source bindings isolate personal credentials over HTTP", () =>
    Effect.gen(function* () {
      const orgId = `org_${crypto.randomUUID()}`;
      const aliceId = `user_${crypto.randomUUID().slice(0, 8)}`;
      const bobId = `user_${crypto.randomUUID().slice(0, 8)}`;
      const namespace = `ns_${crypto.randomUUID().replace(/-/g, "_")}`;
      const aliceScope = testUserOrgScopeId(aliceId, orgId);
      const bobScope = testUserOrgScopeId(bobId, orgId);

      yield* asOrg(orgId, (client) =>
        client.openapi.addSpec({
          params: { scopeId: ScopeId.make(orgId) },
          payload: {
            ...makeMinimalOpenApiSourcePayload(ScopeId.make(orgId), namespace),
            headers: {
              Authorization: {
                kind: "binding",
                slot: "auth:personal-token",
                prefix: "Bearer ",
              },
            },
          },
        }),
      );

      yield* asUser(aliceId, orgId, (client) =>
        Effect.gen(function* () {
          yield* client.secrets.set({
            params: { scopeId: ScopeId.make(aliceScope) },
            payload: {
              id: SecretId.make("alice_pat"),
              name: "Alice PAT",
              value: "alice-secret",
            },
          });
          const binding = yield* client.openapi.setSourceBinding({
            params: { scopeId: ScopeId.make(aliceScope) },
            payload: {
              sourceId: namespace,
              sourceScope: ScopeId.make(orgId),
              scope: ScopeId.make(aliceScope),
              slot: "auth:personal-token",
              value: {
                kind: "secret",
                secretId: SecretId.make("alice_pat"),
              },
            },
          });
          expect(binding).toMatchObject({
            sourceId: namespace,
            sourceScopeId: ScopeId.make(orgId),
            scopeId: ScopeId.make(aliceScope),
            slot: "auth:personal-token",
            value: {
              kind: "secret",
              secretId: SecretId.make("alice_pat"),
            },
          });
          expect(binding.createdAt).toBeInstanceOf(Date);
          expect(binding.updatedAt).toBeInstanceOf(Date);
        }),
      );

      yield* asUser(bobId, orgId, (client) =>
        Effect.gen(function* () {
          yield* client.secrets.set({
            params: { scopeId: ScopeId.make(bobScope) },
            payload: {
              id: SecretId.make("bob_pat"),
              name: "Bob PAT",
              value: "bob-secret",
            },
          });
          yield* client.openapi.setSourceBinding({
            params: { scopeId: ScopeId.make(bobScope) },
            payload: {
              sourceId: namespace,
              sourceScope: ScopeId.make(orgId),
              scope: ScopeId.make(bobScope),
              slot: "auth:personal-token",
              value: {
                kind: "secret",
                secretId: SecretId.make("bob_pat"),
              },
            },
          });
        }),
      );

      const aliceBindings = yield* asUser(aliceId, orgId, (client) =>
        client.openapi.listSourceBindings({
          params: {
            scopeId: ScopeId.make(aliceScope),
            namespace,
            sourceScopeId: ScopeId.make(orgId),
          },
        }),
      );
      expect(aliceBindings).toContainEqual(
        expect.objectContaining({
          scopeId: ScopeId.make(aliceScope),
          slot: "auth:personal-token",
          value: {
            kind: "secret",
            secretId: SecretId.make("alice_pat"),
            secretScopeId: ScopeId.make(aliceScope),
          },
        }),
      );
      expect(
        aliceBindings.some(
          (binding) =>
            binding.slot === "auth:personal-token" &&
            binding.value.kind === "secret" &&
            binding.value.secretId === SecretId.make("bob_pat"),
        ),
      ).toBe(false);

      const bobBindings = yield* asUser(bobId, orgId, (client) =>
        client.openapi.listSourceBindings({
          params: {
            scopeId: ScopeId.make(bobScope),
            namespace,
            sourceScopeId: ScopeId.make(orgId),
          },
        }),
      );
      expect(bobBindings).toContainEqual(
        expect.objectContaining({
          scopeId: ScopeId.make(bobScope),
          slot: "auth:personal-token",
          value: {
            kind: "secret",
            secretId: SecretId.make("bob_pat"),
            secretScopeId: ScopeId.make(bobScope),
          },
        }),
      );
      expect(
        bobBindings.some(
          (binding) =>
            binding.slot === "auth:personal-token" &&
            binding.value.kind === "secret" &&
            binding.value.secretId === SecretId.make("alice_pat"),
        ),
      ).toBe(false);

      const sources = yield* asOrg(orgId, (client) =>
        client.sources.list({ params: { scopeId: ScopeId.make(orgId) } }),
      );
      expect(sources.find((source) => source.id === namespace)?.scopeId).toBe(ScopeId.make(orgId));
    }),
  );

  it.effect(
    "addSpec persists the full Cloudflare spec through the real Drizzle/FumaDB path",
    () =>
      Effect.gen(function* () {
        const org = `org_${crypto.randomUUID()}`;
        const namespace = `ns_${crypto.randomUUID().replace(/-/g, "_")}`;

        const result = yield* asOrg(org, (client) =>
          client.openapi.addSpec({
            params: { scopeId: ScopeId.make(org) },
            payload: {
              targetScope: ScopeId.make(org),
              spec: CLOUDFLARE_SPEC,
              namespace,
            },
          }),
        );
        expect(result.namespace).toBe(namespace);
        expect(result.toolCount).toBeGreaterThan(1000);

        const sources = yield* asOrg(org, (client) =>
          client.sources.list({ params: { scopeId: ScopeId.make(org) } }),
        );
        expect(sources.map((s) => s.id)).toContain(namespace);

        // removeSpec on the same size must also land cleanly — catches
        // symmetrical regressions on the delete side (e.g. deleteMany
        // fanning out to per-row deletes).
        yield* asOrg(org, (client) =>
          client.sources.remove({
            params: { scopeId: ScopeId.make(org), sourceId: namespace },
          }),
        );
        const after = yield* asOrg(org, (client) =>
          client.sources.list({ params: { scopeId: ScopeId.make(org) } }),
        );
        expect(after.map((s) => s.id)).not.toContain(namespace);
      }),
    // 60s is generous for a correct O(1) write path on local PGlite;
    // a per-row regression would take minutes and hit this ceiling
    // long before the suite would tolerate it.
    { timeout: 60_000 },
  );
});
