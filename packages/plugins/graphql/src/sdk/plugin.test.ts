import { describe, it, expect } from "@effect/vitest";
import { Effect, Predicate } from "effect";
import { HttpServerRequest, HttpServerResponse } from "effect/unstable/http";

import {
  ConnectionId,
  CreateConnectionInput,
  createExecutor,
  definePlugin,
  ElicitationResponse,
  RemoveSecretInput,
  Scope,
  ScopeId,
  SecretId,
  TokenMaterial,
} from "@executor-js/sdk";
import { makeTestConfig, serveTestHttpApp } from "@executor-js/sdk/testing";
import { memorySecretsPlugin } from "@executor-js/sdk/testing";

import { graphqlPlugin } from "./plugin";
import { endpointForTelemetry } from "./invoke";
import { introspect } from "./introspect";
import { GRAPHQL_OAUTH_CONNECTION_SLOT, graphqlHeaderSlot, graphqlQueryParamSlot } from "./types";
import type { IntrospectionResult } from "./introspect";
import {
  makeGreetingGraphqlSchema,
  serveGraphqlFailureTestServer,
  serveGraphqlTestServer,
} from "../testing";

const TEST_SCOPE = "test-scope";
const graphqlOAuth2Config = {
  kind: "oauth2" as const,
  securitySchemeName: "OAuth2",
  flow: "authorizationCode" as const,
  tokenUrl: "https://auth.example.test/token",
  authorizationUrl: "https://auth.example.test/authorize",
  clientIdSlot: "auth:oauth2:client-id",
  clientSecretSlot: null,
  connectionSlot: GRAPHQL_OAUTH_CONNECTION_SLOT,
  scopes: [],
};

// ---------------------------------------------------------------------------
// Mock introspection response
// ---------------------------------------------------------------------------

const introspectionResult: IntrospectionResult = {
  __schema: {
    queryType: { name: "Query" },
    mutationType: { name: "Mutation" },
    types: [
      {
        kind: "OBJECT",
        name: "Query",
        description: null,
        fields: [
          {
            name: "hello",
            description: "Say hello",
            args: [
              {
                name: "name",
                description: null,
                type: { kind: "SCALAR", name: "String", ofType: null },
                defaultValue: null,
              },
            ],
            type: { kind: "SCALAR", name: "String", ofType: null },
          },
        ],
        inputFields: null,
        enumValues: null,
      },
      {
        kind: "OBJECT",
        name: "Mutation",
        description: null,
        fields: [
          {
            name: "setGreeting",
            description: "Set greeting message",
            args: [
              {
                name: "message",
                description: null,
                type: {
                  kind: "NON_NULL",
                  name: null,
                  ofType: { kind: "SCALAR", name: "String", ofType: null },
                },
                defaultValue: null,
              },
            ],
            type: { kind: "SCALAR", name: "String", ofType: null },
          },
        ],
        inputFields: null,
        enumValues: null,
      },
      {
        kind: "SCALAR",
        name: "String",
        description: null,
        fields: null,
        inputFields: null,
        enumValues: null,
      },
    ],
  },
};

const introspectionJson = JSON.stringify({ data: introspectionResult });
const serveGreetingServer = serveGraphqlTestServer({ schema: makeGreetingGraphqlSchema() });
const declineAll = () => Effect.succeed(ElicitationResponse.make({ action: "decline" }));

const sampleDataPlugin = definePlugin(() => ({
  id: "sample-read-test" as const,
  storage: () => ({}),
  staticSources: () => [
    {
      id: "sample",
      kind: "in-memory",
      name: "Sample",
      tools: [
        {
          name: "read",
          description: "Read sample data",
          inputSchema: {
            type: "object",
            properties: {},
            additionalProperties: false,
          },
          handler: () => Effect.succeed("sample-value"),
        },
      ],
    },
  ],
}));

describe("graphqlPlugin real protocol server", () => {
  it("uses query-free endpoints for invocation attributes", () => {
    expect(endpointForTelemetry("https://api.example.test/graphql?token=secret#section")).toBe(
      "https://api.example.test/graphql",
    );
  });

  it.effect("includes redacted upstream text in introspection status errors", () =>
    Effect.gen(function* () {
      const server = yield* serveGraphqlFailureTestServer({
        status: 500,
        body: 'upstream failed {"access_token":"secret-value"} token=another-secret',
      });

      const error = yield* introspect(server.endpoint).pipe(
        Effect.provide(server.httpClientLayer),
        Effect.flip,
      );

      expect(error).toHaveProperty(
        "message",
        'Introspection failed with status 500: upstream failed {"access_token":"[redacted]"} token=[redacted]',
      );
      expect(error).not.toHaveProperty("message", expect.stringContaining("secret-value"));
      expect(error).not.toHaveProperty("message", expect.stringContaining("another-secret"));
    }),
  );

  it.effect("includes safe upstream JSON messages in introspection status errors", () =>
    Effect.gen(function* () {
      const server = yield* serveTestHttpApp(() =>
        Effect.succeed(
          HttpServerResponse.jsonUnsafe(
            { message: "Resource protected by organization SSO" },
            { status: 403 },
          ),
        ),
      );

      const error = yield* introspect(server.url("/graphql")).pipe(
        Effect.provide(server.httpClientLayer),
        Effect.flip,
      );

      expect(error).toHaveProperty(
        "message",
        "Introspection failed with status 403: Resource protected by organization SSO",
      );
    }),
  );

  it.effect("redacts secrets from upstream JSON messages in introspection status errors", () =>
    Effect.gen(function* () {
      const server = yield* serveTestHttpApp(() =>
        Effect.succeed(
          HttpServerResponse.jsonUnsafe(
            { message: "Authorization: Bearer github-secret-token" },
            { status: 403 },
          ),
        ),
      );

      const error = yield* introspect(server.url("/graphql")).pipe(
        Effect.provide(server.httpClientLayer),
        Effect.flip,
      );

      expect(error).toHaveProperty(
        "message",
        "Introspection failed with status 403: Authorization: [redacted]",
      );
      expect(error).not.toHaveProperty("message", expect.stringContaining("github-secret-token"));
    }),
  );

  it.effect("accepts standard introspection responses with omitted deepest ofType", () =>
    Effect.gen(function* () {
      const deepType = {
        kind: "NON_NULL",
        name: null,
        ofType: {
          kind: "LIST",
          name: null,
          ofType: {
            kind: "NON_NULL",
            name: null,
            ofType: {
              kind: "LIST",
              name: null,
              ofType: {
                kind: "NON_NULL",
                name: null,
                ofType: {
                  kind: "SCALAR",
                  name: "String",
                },
              },
            },
          },
        },
      };
      const server = yield* serveTestHttpApp(() =>
        Effect.succeed(
          HttpServerResponse.jsonUnsafe({
            data: {
              __schema: {
                queryType: { name: "Query" },
                mutationType: null,
                types: [
                  {
                    kind: "OBJECT",
                    name: "Query",
                    description: null,
                    fields: [
                      {
                        name: "deep",
                        description: null,
                        args: [],
                        type: deepType,
                      },
                    ],
                    inputFields: null,
                    enumValues: null,
                  },
                  {
                    kind: "SCALAR",
                    name: "String",
                    description: null,
                    fields: null,
                    inputFields: null,
                    enumValues: null,
                  },
                ],
              },
            },
          }),
        ),
      );

      const result = yield* introspect(server.url("/graphql")).pipe(
        Effect.provide(server.httpClientLayer),
      );

      expect(result.__schema.queryType?.name).toBe("Query");
    }),
  );

  it.effect("adds a source by introspecting the live GraphQL endpoint", () =>
    Effect.gen(function* () {
      const server = yield* serveGreetingServer;
      const executor = yield* createExecutor(
        makeTestConfig({ plugins: [graphqlPlugin()] as const }),
      );

      const result = yield* executor.graphql.addSource({
        endpoint: server.endpoint,
        scope: TEST_SCOPE,
        namespace: "live_graph",
      });

      expect(result).toEqual({ toolCount: 2, namespace: "live_graph" });

      const tools = yield* executor.tools.list();
      expect(tools.map((tool) => tool.id)).toEqual(
        expect.arrayContaining(["live_graph.query.hello", "live_graph.mutation.setGreeting"]),
      );

      const requests = yield* server.requests;
      expect(requests.some((request) => request.payload.query?.includes("__schema"))).toBe(true);
    }),
  );

  it.effect("uses initial credential bindings for add-time introspection", () =>
    Effect.gen(function* () {
      const server = yield* serveGraphqlTestServer({
        schema: makeGreetingGraphqlSchema(),
        auth: {
          validateAuthorization: (authorization) =>
            Effect.succeed(authorization === "Bearer secret-token"),
        },
      });
      const executor = yield* createExecutor(
        makeTestConfig({ plugins: [memorySecretsPlugin(), graphqlPlugin()] as const }),
      );
      yield* executor.secrets.set({
        id: SecretId.make("github-token"),
        scope: ScopeId.make(TEST_SCOPE),
        name: "GitHub token",
        value: "secret-token",
        provider: "memory",
      });

      const result = yield* executor.graphql.addSource({
        endpoint: server.endpoint,
        scope: TEST_SCOPE,
        namespace: "initial_credentials",
        headers: {
          Authorization: { kind: "secret", prefix: "Bearer " },
        },
        credentials: {
          scope: TEST_SCOPE,
          headers: {
            Authorization: { kind: "secret", secretId: "github-token" },
          },
        },
      });

      expect(result).toEqual({ toolCount: 2, namespace: "initial_credentials" });
      const requests = yield* server.requests;
      expect(
        requests.some((request) => request.headers.authorization === "Bearer secret-token"),
      ).toBe(true);
    }),
  );

  it.effect(
    "uses user-scoped initial credential bindings for org-scope add-time introspection",
    () =>
      Effect.gen(function* () {
        const orgScope = "org-scope";
        const userScope = "user-scope";
        const server = yield* serveGraphqlTestServer({
          schema: makeGreetingGraphqlSchema(),
          auth: {
            validateAuthorization: (authorization) =>
              Effect.succeed(authorization === "Bearer user-secret-token"),
          },
        });
        const executor = yield* createExecutor(
          makeTestConfig({
            scopes: [
              Scope.make({
                id: ScopeId.make(userScope),
                name: "user",
                createdAt: new Date(),
              }),
              Scope.make({
                id: ScopeId.make(orgScope),
                name: "org",
                createdAt: new Date(),
              }),
            ],
            plugins: [memorySecretsPlugin(), graphqlPlugin()] as const,
          }),
        );
        yield* executor.secrets.set({
          id: SecretId.make("github-graphql-authorization"),
          scope: ScopeId.make(userScope),
          name: "GitHub GraphQL Authorization",
          value: "user-secret-token",
          provider: "memory",
        });

        const result = yield* executor.graphql.addSource({
          endpoint: server.endpoint,
          scope: orgScope,
          name: "Github GraphQL",
          namespace: "github_graphql",
          headers: {
            Authorization: { kind: "secret", prefix: "Bearer " },
          },
          credentials: {
            scope: userScope,
            headers: {
              Authorization: {
                kind: "secret",
                secretId: "github-graphql-authorization",
                secretScope: userScope,
                prefix: "Bearer ",
              },
            },
          },
        });

        expect(result).toEqual({ toolCount: 2, namespace: "github_graphql" });
        const requests = yield* server.requests;
        expect(
          requests.some((request) => request.headers.authorization === "Bearer user-secret-token"),
        ).toBe(true);
      }),
  );

  it.effect("marks source oauth-backed when add-time credentials include oauth", () =>
    Effect.gen(function* () {
      const server = yield* serveGraphqlTestServer({
        schema: makeGreetingGraphqlSchema(),
        auth: {
          validateAuthorization: (authorization) =>
            Effect.succeed(authorization === "Bearer oauth-token"),
        },
      });
      const executor = yield* createExecutor(
        makeTestConfig({ plugins: [memorySecretsPlugin(), graphqlPlugin()] as const }),
      );
      const connectionId = ConnectionId.make("graphql-oauth2-initial");
      yield* executor.connections.create(
        CreateConnectionInput.make({
          id: connectionId,
          scope: ScopeId.make(TEST_SCOPE),
          provider: "oauth2",
          identityLabel: "Initial GraphQL OAuth",
          accessToken: TokenMaterial.make({
            secretId: SecretId.make(`${connectionId}.access_token`),
            name: "Initial GraphQL OAuth Access Token",
            value: "oauth-token",
          }),
          refreshToken: null,
          expiresAt: null,
          oauthScope: null,
          providerState: null,
        }),
      );

      const result = yield* executor.graphql.addSource({
        endpoint: server.endpoint,
        scope: TEST_SCOPE,
        namespace: "initial_oauth_graphql",
        credentials: {
          scope: TEST_SCOPE,
          auth: {
            oauth2: {
              connection: { kind: "connection", connectionId },
            },
          },
        },
      });

      expect(result).toEqual({ toolCount: 2, namespace: "initial_oauth_graphql" });
      const source = yield* executor.graphql.getSource("initial_oauth_graphql", TEST_SCOPE);
      expect(source?.auth.kind).toBe("oauth2");
      if (source?.auth.kind !== "oauth2") return;
      expect(source.auth.connectionSlot).toBe(GRAPHQL_OAUTH_CONNECTION_SLOT);
    }),
  );

  it.effect("invokes a live query with headers and query params", () =>
    Effect.gen(function* () {
      const server = yield* serveGreetingServer;
      const executor = yield* createExecutor(
        makeTestConfig({ plugins: [graphqlPlugin()] as const }),
      );

      yield* executor.graphql.addSource({
        endpoint: server.endpoint,
        scope: TEST_SCOPE,
        namespace: "live_invoke",
        headers: { "x-static": "abc" },
        queryParams: { token: "qp-token" },
      });
      yield* server.clearRequests;

      const result = yield* executor.tools.invoke("live_invoke.query.hello", {
        name: "Ada",
      });

      expect(result).toEqual({
        ok: true,
        data: { hello: "Hello Ada" },
      });

      const requests = yield* server.requests;
      expect(requests.length).toBe(1);
      expect(requests[0]?.headers["x-static"]).toBe("abc");
      expect(new URL(requests[0]!.url).searchParams.get("token")).toBe("qp-token");
      expect(requests[0]?.payload.variables).toEqual({ name: "Ada" });
    }),
  );

  it.effect("surfaces non-2xx invocation responses as ToolResult.fail", () =>
    Effect.gen(function* () {
      const server = yield* serveTestHttpApp((request) =>
        Effect.gen(function* () {
          const webRequest = yield* HttpServerRequest.toWeb(request);
          const body = yield* Effect.promise(() => webRequest.text());
          if (body.includes("__schema")) {
            return HttpServerResponse.jsonUnsafe({ data: introspectionResult });
          }
          return HttpServerResponse.text("temporary upstream outage", {
            status: 503,
            contentType: "text/plain",
          });
        }),
      );
      const executor = yield* createExecutor(
        makeTestConfig({ plugins: [graphqlPlugin()] as const }),
      );

      yield* executor.graphql.addSource({
        endpoint: server.url("/graphql"),
        scope: TEST_SCOPE,
        namespace: "http_error_graph",
      });

      const result = yield* executor.tools.invoke("http_error_graph.query.hello", {
        name: "Ada",
      });

      expect(result).toMatchObject({
        ok: false,
        error: {
          code: "graphql_http_error",
          status: 503,
          message: "GraphQL request failed with HTTP 503",
        },
      });
    }),
  );

  it.effect("invokes OAuth-backed sources with a bearer token", () =>
    Effect.gen(function* () {
      const server = yield* serveGreetingServer;
      const executor = yield* createExecutor(
        makeTestConfig({
          plugins: [memorySecretsPlugin(), graphqlPlugin()] as const,
        }),
      );

      const connectionId = ConnectionId.make("graphql-oauth2-test");
      yield* executor.connections.create(
        CreateConnectionInput.make({
          id: connectionId,
          scope: ScopeId.make(TEST_SCOPE),
          provider: "oauth2",
          identityLabel: "GraphQL Test",
          accessToken: TokenMaterial.make({
            secretId: SecretId.make(`${connectionId}.access_token`),
            name: "GraphQL Access Token",
            value: "secret-token",
          }),
          refreshToken: null,
          expiresAt: null,
          oauthScope: null,
          providerState: null,
        }),
      );

      yield* executor.graphql.addSource({
        endpoint: server.endpoint,
        scope: TEST_SCOPE,
        namespace: "oauth_graph",
        oauth2: graphqlOAuth2Config,
      });
      yield* executor.sources.configure({
        source: { id: "oauth_graph", scope: ScopeId.make(TEST_SCOPE) },
        scope: ScopeId.make(TEST_SCOPE),
        type: "graphql",
        config: {
          auth: {
            oauth2: {
              connection: { kind: "connection", connectionId },
            },
          },
        },
      });
      yield* server.clearRequests;

      const result = yield* executor.tools.invoke("oauth_graph.query.hello", {
        name: "Ada",
      });

      expect(result).toEqual({
        ok: true,
        data: { hello: "Hello Ada" },
      });

      const requests = yield* server.requests;
      expect(requests[0]?.headers.authorization).toBe("Bearer secret-token");
    }),
  );

  it.effect("returns an auth failure when an OAuth-backed source has no connection binding", () =>
    Effect.gen(function* () {
      const server = yield* serveGreetingServer;
      const executor = yield* createExecutor(
        makeTestConfig({
          plugins: [memorySecretsPlugin(), graphqlPlugin()] as const,
        }),
      );

      yield* executor.graphql.addSource({
        endpoint: server.endpoint,
        scope: TEST_SCOPE,
        namespace: "oauth_missing_connection",
        oauth2: graphqlOAuth2Config,
      });

      const result = yield* executor.tools.invoke("oauth_missing_connection.query.hello", {
        name: "Ada",
      });

      expect(result).toMatchObject({
        ok: false,
        error: {
          code: "oauth_connection_missing",
          message: expect.stringContaining("Missing OAuth connection binding"),
          details: {
            category: "authentication",
            recovery: {
              startOAuthTool: "executor.coreTools.oauth.start",
            },
          },
        },
      });
    }),
  );
});

describe("graphqlPlugin", () => {
  it.effect("registers tools from introspection JSON", () =>
    Effect.gen(function* () {
      const executor = yield* createExecutor(
        makeTestConfig({ plugins: [graphqlPlugin()] as const }),
      );

      const result = yield* executor.graphql.addSource({
        endpoint: "http://localhost:4000/graphql",
        scope: "test-scope",
        introspectionJson,
        namespace: "test_api",
      });
      expect(result.toolCount).toBe(2);
      expect(result.namespace).toBe("test_api");

      const tools = yield* executor.tools.list();
      const ids = tools.map((t) => t.id);
      expect(ids).toContain("test_api.query.hello");
      expect(ids).toContain("test_api.mutation.setGreeting");
      // static executor tool also present under the executor namespace
      expect(ids).toContain("executor.graphql.getSource");
      expect(ids).toContain("executor.graphql.addSource");
      expect(ids).toContain("executor.graphql.configureSource");

      const queryTool = tools.find((t) => t.id === "test_api.query.hello");
      expect(queryTool?.description).toBe("Say hello");

      const mutationTool = tools.find((t) => t.id === "test_api.mutation.setGreeting");
      expect(mutationTool?.description).toBe("Set greeting message");
    }),
  );

  it.effect("removes a source and its tools", () =>
    Effect.gen(function* () {
      const executor = yield* createExecutor(
        makeTestConfig({ plugins: [graphqlPlugin()] as const }),
      );

      yield* executor.graphql.addSource({
        endpoint: "http://localhost:4000/graphql",
        scope: "test-scope",
        introspectionJson,
        namespace: "removable",
      });

      let tools = yield* executor.tools.list();
      expect(tools.filter((t) => t.sourceId === "removable").length).toBe(2);

      yield* executor.graphql.removeSource("removable", TEST_SCOPE);

      tools = yield* executor.tools.list();
      expect(tools.filter((t) => t.sourceId === "removable").length).toBe(0);

      const source = yield* executor.graphql.getSource("removable", TEST_SCOPE);
      expect(source).toBeNull();
    }),
  );

  it.effect("lists sources with the executor built-in source", () =>
    Effect.gen(function* () {
      const executor = yield* createExecutor(
        makeTestConfig({ plugins: [graphqlPlugin()] as const }),
      );

      yield* executor.graphql.addSource({
        endpoint: "http://localhost:4000/graphql",
        scope: "test-scope",
        introspectionJson,
        namespace: "my_gql",
      });

      const sources = yield* executor.sources.list();
      const dynamic = sources.find((s) => s.id === "my_gql");
      expect(dynamic).toBeDefined();
      expect(dynamic!.kind).toBe("graphql");
      expect(dynamic!.canRemove).toBe(true);
      expect(dynamic!.canEdit).toBe(true);
      expect(dynamic!.runtime).toBe(false);

      expect(sources.find((s) => s.id === "graphql")).toBeUndefined();
      const control = sources.find((s) => s.id === "executor");
      expect(control).toBeDefined();
      expect(control!.runtime).toBe(true);
    }),
  );

  it.effect("mutations require approval via resolveAnnotations", () =>
    Effect.gen(function* () {
      const executor = yield* createExecutor(
        makeTestConfig({ plugins: [graphqlPlugin()] as const }),
      );

      yield* executor.graphql.addSource({
        endpoint: "http://localhost:4000/graphql",
        scope: "test-scope",
        introspectionJson,
        namespace: "approval_test",
      });

      const tools = yield* executor.tools.list();
      const mutationTool = tools.find((t) => t.id === "approval_test.mutation.setGreeting");
      expect(mutationTool).toBeDefined();
      expect(mutationTool!.annotations?.requiresApproval).toBe(true);
      expect(mutationTool!.annotations?.approvalDescription).toBe("mutation setGreeting");

      const queryTool = tools.find((t) => t.id === "approval_test.query.hello");
      expect(queryTool).toBeDefined();
      expect(queryTool!.annotations?.requiresApproval).toBeFalsy();
    }),
  );

  it.effect("sources.configure patches endpoint/headers without re-registering", () =>
    Effect.gen(function* () {
      const executor = yield* createExecutor(
        makeTestConfig({ plugins: [graphqlPlugin()] as const }),
      );

      yield* executor.graphql.addSource({
        endpoint: "http://localhost:4000/graphql",
        scope: "test-scope",
        introspectionJson,
        namespace: "patched",
      });

      yield* executor.sources.configure({
        source: { id: "patched", scope: ScopeId.make(TEST_SCOPE) },
        scope: ScopeId.make(TEST_SCOPE),
        type: "graphql",
        config: {
          endpoint: "http://localhost:5000/graphql",
          headers: { "x-custom": "abc" },
        },
      });

      const source = yield* executor.graphql.getSource("patched", TEST_SCOPE);
      expect(source?.endpoint).toBe("http://localhost:5000/graphql");
      expect(source?.headers).toEqual({ "x-custom": "abc" });

      // Tools still present (no re-register happened, but they were
      // already there from addSource and haven't been removed).
      const tools = yield* executor.tools.list();
      expect(tools.filter((t) => t.sourceId === "patched").length).toBe(2);
    }),
  );

  it.effect("static executor.graphql.addSource delegates to extension", () =>
    Effect.gen(function* () {
      const userScope = ScopeId.make("static-user");
      const orgScope = ScopeId.make("static-org");
      const executor = yield* createExecutor(
        makeTestConfig({
          scopes: [
            Scope.make({ id: userScope, name: "user", createdAt: new Date() }),
            Scope.make({ id: orgScope, name: "org", createdAt: new Date() }),
          ],
          plugins: [graphqlPlugin()] as const,
        }),
      );

      const result = yield* executor.tools.invoke(
        "executor.graphql.addSource",
        {
          endpoint: "http://localhost:4000/graphql",
          name: "Via Static",
          introspectionJson,
          namespace: "via_static",
        },
        { onElicitation: "accept-all" },
      );
      expect(result).toEqual({
        ok: true,
        data: {
          namespace: "via_static",
          source: { id: "via_static", scope: String(orgScope) },
          toolCount: 2,
        },
      });
      expect(yield* executor.graphql.getSource("via_static", String(userScope))).toBeNull();
      expect((yield* executor.graphql.getSource("via_static", String(orgScope)))?.scope).toBe(
        orgScope,
      );
      const inspected = yield* executor.tools.invoke(
        "executor.graphql.getSource",
        { namespace: "via_static", scope: "org" },
        { onElicitation: "accept-all" },
      );
      expect(inspected).toMatchObject({
        ok: true,
        data: { source: { namespace: "via_static", scope: String(orgScope) } },
      });

      const tools = yield* executor.tools.list();
      expect(tools.filter((t) => t.sourceId === "via_static").length).toBe(2);
    }),
  );

  it.effect("static executor.graphql.addSource returns actionable tool failures", () =>
    Effect.gen(function* () {
      const config = makeTestConfig({ plugins: [graphqlPlugin()] as const });
      const executor = yield* createExecutor(config);

      const result = yield* executor.tools.invoke(
        "executor.graphql.addSource",
        {
          endpoint: "http://127.0.0.1:1/graphql",
          name: "Broken GraphQL",
          namespace: "broken_graphql",
        },
        { onElicitation: "accept-all" },
      );

      expect(result).toMatchObject({
        ok: false,
        error: {
          code: "graphql_introspection_failed",
        },
      });

      yield* executor.close();
      yield* Effect.promise(() => config.testDb.close());
    }),
  );

  it.effect("describes static addSource parameters from Standard Schema", () =>
    Effect.gen(function* () {
      const executor = yield* createExecutor(makeTestConfig({ plugins: [graphqlPlugin()] }));

      const schema = yield* executor.tools.schema("executor.graphql.addSource");

      expect(schema).not.toBeNull();
      expect(schema!.inputTypeScript).toContain("endpoint: string");
      expect(schema!.inputTypeScript).toContain("credentials?: { scope: string");
      expect(
        (schema!.inputSchema as { properties?: Record<string, unknown> }).properties,
      ).not.toHaveProperty("scope");
      expect(
        (schema!.inputSchema as { properties?: Record<string, unknown> }).properties,
      ).not.toHaveProperty("targetScope");
      expect(schema!.inputTypeScript).not.toBe("Record<string, unknown>");
    }),
  );

  it.effect("requires approval before a runtime-added query sends prior tool output", () =>
    Effect.gen(function* () {
      const server = yield* serveGreetingServer;
      const executor = yield* createExecutor(
        makeTestConfig({ plugins: [sampleDataPlugin(), graphqlPlugin()] as const }),
      );

      const trusted = yield* executor.tools.invoke(
        "sample.read",
        {},
        { onElicitation: declineAll },
      );
      expect(trusted).toBe("sample-value");
      const declined = yield* executor.tools
        .invoke(
          "executor.graphql.addSource",
          {
            endpoint: server.endpoint,
            introspectionJson,
            namespace: "runtime_graphql",
          },
          { onElicitation: declineAll },
        )
        .pipe(Effect.flip);
      expect(Predicate.isTagged(declined, "ElicitationDeclinedError")).toBe(true);

      const requests = yield* server.requests;
      expect(requests.some((request) => request.payload.variables?.name === "sample-value")).toBe(
        false,
      );
    }),
  );

  it.effect("applies source headers to the introspection request after approval", () =>
    Effect.gen(function* () {
      const server = yield* serveGreetingServer;
      const executor = yield* createExecutor(
        makeTestConfig({ plugins: [graphqlPlugin()] as const }),
      );

      yield* executor.tools.invoke(
        "executor.graphql.addSource",
        {
          endpoint: server.endpoint,
          scope: TEST_SCOPE,
          name: "Header Materialization",
          namespace: "header_materialization",
          headers: {
            authorization: "Bearer sample-token",
          },
        },
        { onElicitation: "accept-all" },
      );

      const requests = yield* server.requests;
      expect(
        requests.some((request) => request.headers.authorization === "Bearer sample-token"),
      ).toBe(true);
    }),
  );

  // -------------------------------------------------------------------------
  // Multi-scope shadowing — regression suite covering the bug class where
  // store reads/writes that don't pin scope_id collapse onto whichever visible
  // row wins first. Each
  // scenario is reproducible against the pre-fix store.
  // -------------------------------------------------------------------------

  const ORG_SCOPE = "org-scope";
  const USER_SCOPE = "user-scope";

  const stackedScopes = [
    Scope.make({
      id: ScopeId.make(USER_SCOPE),
      name: "user",
      createdAt: new Date(),
    }),
    Scope.make({
      id: ScopeId.make(ORG_SCOPE),
      name: "org",
      createdAt: new Date(),
    }),
  ] as const;

  it.effect("shadowed addSource does not wipe the outer-scope source", () =>
    Effect.gen(function* () {
      const executor = yield* createExecutor(
        makeTestConfig({
          scopes: stackedScopes,
          plugins: [graphqlPlugin()] as const,
        }),
      );

      // Org-level base source
      yield* executor.graphql.addSource({
        endpoint: "http://org.example.com/graphql",
        scope: ORG_SCOPE,
        introspectionJson,
        namespace: "shared",
        name: "Org Source",
      });

      // Per-user shadow with the same namespace
      yield* executor.graphql.addSource({
        endpoint: "http://user.example.com/graphql",
        scope: USER_SCOPE,
        introspectionJson,
        namespace: "shared",
        name: "User Source",
      });

      const userView = yield* executor.graphql.getSource("shared", USER_SCOPE);
      const orgView = yield* executor.graphql.getSource("shared", ORG_SCOPE);

      // Both rows must coexist — innermost-wins reads come from the
      // executor; the store's scope-pinned getters return the exact row.
      expect(userView?.name).toBe("User Source");
      expect(userView?.scope).toBe(USER_SCOPE);
      expect(userView?.endpoint).toBe("http://user.example.com/graphql");
      expect(orgView?.name).toBe("Org Source");
      expect(orgView?.scope).toBe(ORG_SCOPE);
      expect(orgView?.endpoint).toBe("http://org.example.com/graphql");
    }),
  );

  it.effect("removeSource on user shadow leaves the org row intact", () =>
    Effect.gen(function* () {
      const executor = yield* createExecutor(
        makeTestConfig({
          scopes: stackedScopes,
          plugins: [graphqlPlugin()] as const,
        }),
      );

      yield* executor.graphql.addSource({
        endpoint: "http://org.example.com/graphql",
        scope: ORG_SCOPE,
        introspectionJson,
        namespace: "shared",
        name: "Org Source",
      });
      yield* executor.graphql.addSource({
        endpoint: "http://user.example.com/graphql",
        scope: USER_SCOPE,
        introspectionJson,
        namespace: "shared",
        name: "User Source",
      });

      yield* executor.graphql.removeSource("shared", USER_SCOPE);

      const userView = yield* executor.graphql.getSource("shared", USER_SCOPE);
      const orgView = yield* executor.graphql.getSource("shared", ORG_SCOPE);

      expect(userView).toBeNull();
      expect(orgView?.name).toBe("Org Source");
      expect(orgView?.endpoint).toBe("http://org.example.com/graphql");
    }),
  );

  it.effect("sources.configure on user shadow does not mutate the org row", () =>
    Effect.gen(function* () {
      const executor = yield* createExecutor(
        makeTestConfig({
          scopes: stackedScopes,
          plugins: [graphqlPlugin()] as const,
        }),
      );

      yield* executor.graphql.addSource({
        endpoint: "http://org.example.com/graphql",
        scope: ORG_SCOPE,
        introspectionJson,
        namespace: "shared",
        name: "Org Source",
      });
      yield* executor.graphql.addSource({
        endpoint: "http://user.example.com/graphql",
        scope: USER_SCOPE,
        introspectionJson,
        namespace: "shared",
        name: "User Source",
      });

      yield* executor.sources.configure({
        source: { id: "shared", scope: ScopeId.make(USER_SCOPE) },
        scope: ScopeId.make(USER_SCOPE),
        type: "graphql",
        config: {
          name: "User Renamed",
          endpoint: "http://user-new.example.com/graphql",
        },
      });

      const userView = yield* executor.graphql.getSource("shared", USER_SCOPE);
      const orgView = yield* executor.graphql.getSource("shared", ORG_SCOPE);

      expect(userView?.name).toBe("User Renamed");
      expect(userView?.endpoint).toBe("http://user-new.example.com/graphql");
      expect(orgView?.name).toBe("Org Source");
      expect(orgView?.endpoint).toBe("http://org.example.com/graphql");
    }),
  );

  it.effect("credential bindings let a user override org GraphQL headers and query params", () =>
    Effect.gen(function* () {
      const server = yield* serveGreetingServer;
      const executor = yield* createExecutor(
        makeTestConfig({
          scopes: stackedScopes,
          plugins: [memorySecretsPlugin(), graphqlPlugin()] as const,
        }),
      );

      yield* executor.secrets.set({
        id: SecretId.make("org-token"),
        scope: ScopeId.make(ORG_SCOPE),
        name: "Org token",
        value: "org-secret",
        provider: "memory",
      });
      yield* executor.secrets.set({
        id: SecretId.make("org-query"),
        scope: ScopeId.make(ORG_SCOPE),
        name: "Org query",
        value: "org-query-secret",
        provider: "memory",
      });
      yield* executor.secrets.set({
        id: SecretId.make("user-token"),
        scope: ScopeId.make(USER_SCOPE),
        name: "User token",
        value: "user-secret",
        provider: "memory",
      });
      yield* executor.secrets.set({
        id: SecretId.make("user-query"),
        scope: ScopeId.make(USER_SCOPE),
        name: "User query",
        value: "user-query-secret",
        provider: "memory",
      });

      yield* executor.graphql.addSource({
        endpoint: server.endpoint,
        scope: ORG_SCOPE,
        namespace: "shared_credentials",
        introspectionJson,
        headers: {
          Authorization: { kind: "secret", prefix: "Bearer " },
        },
        queryParams: {
          token: { kind: "secret" },
        },
      });
      yield* executor.sources.configure({
        source: { id: "shared_credentials", scope: ScopeId.make(ORG_SCOPE) },
        scope: ScopeId.make(ORG_SCOPE),
        type: "graphql",
        config: {
          headers: {
            Authorization: { kind: "secret", secretId: "org-token", prefix: "Bearer " },
          },
          queryParams: {
            token: { kind: "secret", secretId: "org-query" },
          },
        },
      });

      yield* executor.sources.setBinding({
        source: { id: "shared_credentials", scope: ScopeId.make(ORG_SCOPE) },
        scope: ScopeId.make(USER_SCOPE),
        slotKey: graphqlHeaderSlot("Authorization"),
        value: { kind: "secret", secretId: SecretId.make("user-token") },
      });
      yield* executor.sources.setBinding({
        source: { id: "shared_credentials", scope: ScopeId.make(ORG_SCOPE) },
        scope: ScopeId.make(USER_SCOPE),
        slotKey: graphqlQueryParamSlot("token"),
        value: { kind: "secret", secretId: SecretId.make("user-query") },
      });

      yield* server.clearRequests;
      const result = yield* executor.tools.invoke("shared_credentials.query.hello", {
        name: "Ada",
      });

      expect(result).toMatchObject({
        ok: true,
        data: { hello: "Hello Ada" },
      });
      const requests = yield* server.requests;
      expect(requests[0]?.headers.authorization).toBe("Bearer user-secret");
      expect(new URL(requests[0]!.url).searchParams.get("token")).toBe("user-query-secret");
    }),
  );

  it.effect("sources.configure stores GraphQL credential bindings at the target scope", () =>
    Effect.gen(function* () {
      const executor = yield* createExecutor(
        makeTestConfig({
          scopes: stackedScopes,
          plugins: [memorySecretsPlugin(), graphqlPlugin()] as const,
        }),
      );

      yield* executor.secrets.set({
        id: SecretId.make("row-user-token"),
        scope: ScopeId.make(USER_SCOPE),
        name: "User token",
        value: "user-secret",
        provider: "memory",
      });
      yield* executor.secrets.set({
        id: SecretId.make("row-org-query"),
        scope: ScopeId.make(ORG_SCOPE),
        name: "Org query",
        value: "org-secret",
        provider: "memory",
      });

      yield* executor.graphql.addSource({
        endpoint: "https://example.com/graphql",
        scope: ORG_SCOPE,
        namespace: "row_scoped_credentials",
        introspectionJson,
        headers: {
          Authorization: { kind: "secret", prefix: "Bearer " },
        },
        queryParams: {
          token: { kind: "secret" },
        },
      });
      yield* executor.sources.configure({
        source: { id: "row_scoped_credentials", scope: ScopeId.make(ORG_SCOPE) },
        scope: ScopeId.make(ORG_SCOPE),
        type: "graphql",
        config: {
          headers: {
            Authorization: {
              kind: "secret",
              secretId: "row-user-token",
              prefix: "Bearer ",
            },
          },
          queryParams: {
            token: {
              kind: "secret",
              secretId: "row-org-query",
            },
          },
        },
      });

      const bindings = yield* executor.sources.listBindings({
        source: { id: "row_scoped_credentials", scope: ScopeId.make(ORG_SCOPE) },
      });

      expect(bindings.map((binding) => binding.slotKey).sort()).toEqual([
        graphqlHeaderSlot("Authorization"),
        graphqlQueryParamSlot("token"),
      ]);
      expect(
        bindings.find((binding) => binding.slotKey === graphqlHeaderSlot("Authorization"))?.scopeId,
      ).toBe(ScopeId.make(ORG_SCOPE));
      expect(
        bindings.find((binding) => binding.slotKey === graphqlQueryParamSlot("token"))?.scopeId,
      ).toBe(ScopeId.make(ORG_SCOPE));
    }),
  );

  it.effect("org header binding resolves the org secret when a user has the same secret id", () =>
    Effect.gen(function* () {
      const server = yield* serveGreetingServer;
      const executor = yield* createExecutor(
        makeTestConfig({
          scopes: stackedScopes,
          plugins: [memorySecretsPlugin(), graphqlPlugin()] as const,
        }),
      );

      yield* executor.secrets.set({
        id: SecretId.make("shared-token"),
        scope: ScopeId.make(ORG_SCOPE),
        name: "Org token",
        value: "org-secret",
        provider: "memory",
      });

      yield* executor.graphql.addSource({
        endpoint: server.endpoint,
        scope: ORG_SCOPE,
        namespace: "org_bound_secret",
        introspectionJson,
        headers: {
          Authorization: { kind: "secret", prefix: "Bearer " },
        },
      });
      yield* executor.sources.configure({
        source: { id: "org_bound_secret", scope: ScopeId.make(ORG_SCOPE) },
        scope: ScopeId.make(ORG_SCOPE),
        type: "graphql",
        config: {
          headers: {
            Authorization: { kind: "secret", secretId: "shared-token", prefix: "Bearer " },
          },
        },
      });

      yield* executor.secrets.set({
        id: SecretId.make("shared-token"),
        scope: ScopeId.make(USER_SCOPE),
        name: "User colliding token",
        value: "user-secret",
        provider: "memory",
      });

      yield* server.clearRequests;
      const result = yield* executor.tools.invoke("org_bound_secret.query.hello", {
        name: "Ada",
      });

      expect(result).toMatchObject({
        ok: true,
        data: { hello: "Hello Ada" },
      });
      const requests = yield* server.requests;
      expect(requests[0]?.headers.authorization).toBe("Bearer org-secret");
    }),
  );

  it.effect(
    "org oauth binding resolves the org connection when a user has the same connection id",
    () =>
      Effect.gen(function* () {
        const server = yield* serveGreetingServer;
        const executor = yield* createExecutor(
          makeTestConfig({
            scopes: stackedScopes,
            plugins: [memorySecretsPlugin(), graphqlPlugin()] as const,
          }),
        );
        const connectionId = ConnectionId.make("shared-graphql-connection");

        yield* executor.connections.create(
          CreateConnectionInput.make({
            id: connectionId,
            scope: ScopeId.make(ORG_SCOPE),
            provider: "oauth2",
            identityLabel: "Org connection",
            accessToken: TokenMaterial.make({
              secretId: SecretId.make("org-shared-graphql-connection.access_token"),
              name: "Org access token",
              value: "org-access-token",
            }),
            refreshToken: null,
            expiresAt: null,
            oauthScope: null,
            providerState: null,
          }),
        );

        yield* executor.graphql.addSource({
          endpoint: server.endpoint,
          scope: ORG_SCOPE,
          namespace: "org_bound_connection",
          introspectionJson,
          oauth2: graphqlOAuth2Config,
        });
        yield* executor.sources.configure({
          source: { id: "org_bound_connection", scope: ScopeId.make(ORG_SCOPE) },
          scope: ScopeId.make(ORG_SCOPE),
          type: "graphql",
          config: {
            auth: {
              oauth2: {
                connection: { kind: "connection", connectionId },
              },
            },
          },
        });

        yield* executor.connections.create(
          CreateConnectionInput.make({
            id: connectionId,
            scope: ScopeId.make(USER_SCOPE),
            provider: "oauth2",
            identityLabel: "User colliding connection",
            accessToken: TokenMaterial.make({
              secretId: SecretId.make("user-shared-graphql-connection.access_token"),
              name: "User access token",
              value: "user-access-token",
            }),
            refreshToken: null,
            expiresAt: null,
            oauthScope: null,
            providerState: null,
          }),
        );

        yield* server.clearRequests;
        const result = yield* executor.tools.invoke("org_bound_connection.query.hello", {
          name: "Ada",
        });

        expect(result).toMatchObject({
          ok: true,
          data: { hello: "Hello Ada" },
        });
        const requests = yield* server.requests;
        expect(requests[0]?.headers.authorization).toBe("Bearer org-access-token");
      }),
  );

  it.effect("sources.configure removes bindings for credential slots no longer present", () =>
    Effect.gen(function* () {
      const executor = yield* createExecutor(
        makeTestConfig({
          scopes: stackedScopes,
          plugins: [memorySecretsPlugin(), graphqlPlugin()] as const,
        }),
      );

      yield* executor.secrets.set({
        id: SecretId.make("old-token"),
        scope: ScopeId.make(ORG_SCOPE),
        name: "Old token",
        value: "old-secret",
        provider: "memory",
      });

      yield* executor.graphql.addSource({
        endpoint: "http://org.example.com/graphql",
        scope: ORG_SCOPE,
        namespace: "stale_binding",
        introspectionJson,
        headers: { "X-Old": { kind: "secret" } },
      });
      yield* executor.sources.configure({
        source: { id: "stale_binding", scope: ScopeId.make(ORG_SCOPE) },
        scope: ScopeId.make(ORG_SCOPE),
        type: "graphql",
        config: { headers: { "X-Old": { kind: "secret", secretId: "old-token" } } },
      });

      yield* executor.sources.configure({
        source: { id: "stale_binding", scope: ScopeId.make(ORG_SCOPE) },
        scope: ScopeId.make(ORG_SCOPE),
        type: "graphql",
        config: { headers: {} },
      });

      const bindings = yield* executor.sources.listBindings({
        source: { id: "stale_binding", scope: ScopeId.make(ORG_SCOPE) },
      });
      expect(bindings).toEqual([]);
    }),
  );

  // -------------------------------------------------------------------------
  // Usage tracking — `usagesForSecret` and `usagesForConnection` should
  // surface every reference to a secret/connection across the plugin's
  // normalized child tables, and `secrets.remove` / `connections.remove`
  // should refuse while a reference exists.
  // -------------------------------------------------------------------------

  it.effect("usagesForSecret returns one Usage per header/query_param ref", () =>
    Effect.gen(function* () {
      const executor = yield* createExecutor(
        makeTestConfig({
          plugins: [memorySecretsPlugin(), graphqlPlugin()] as const,
        }),
      );

      yield* executor.secrets.set({
        id: SecretId.make("api-key"),
        scope: ScopeId.make(TEST_SCOPE),
        name: "API Key",
        value: "abc123",
        provider: "memory",
      });

      yield* executor.graphql.addSource({
        endpoint: "http://localhost:4000/graphql",
        scope: TEST_SCOPE,
        introspectionJson,
        namespace: "with_secret",
        headers: {
          Authorization: { kind: "secret", prefix: "Bearer " },
        },
        queryParams: { token: { kind: "secret" } },
      });
      yield* executor.sources.configure({
        source: { id: "with_secret", scope: ScopeId.make(TEST_SCOPE) },
        scope: ScopeId.make(TEST_SCOPE),
        type: "graphql",
        config: {
          headers: {
            Authorization: { kind: "secret", secretId: "api-key", prefix: "Bearer " },
          },
          queryParams: { token: { kind: "secret", secretId: "api-key" } },
        },
      });

      const usages = yield* executor.secrets.usages(SecretId.make("api-key"));
      // Two refs: one header, one query param.
      expect(usages.length).toBe(2);
      const slots = usages.map((u) => u.slot).sort();
      expect(slots).toEqual(["header:authorization", "query_param:token"]);
      expect(usages.every((u) => u.pluginId === "graphql")).toBe(true);
      expect(usages.every((u) => u.ownerId === "with_secret")).toBe(true);
      expect(usages.every((u) => u.ownerKind === "credential-binding")).toBe(true);
    }),
  );

  it.effect("secrets.remove refuses while a graphql source still uses it", () =>
    Effect.gen(function* () {
      const executor = yield* createExecutor(
        makeTestConfig({
          plugins: [memorySecretsPlugin(), graphqlPlugin()] as const,
        }),
      );

      yield* executor.secrets.set({
        id: SecretId.make("locked"),
        scope: ScopeId.make(TEST_SCOPE),
        name: "Locked",
        value: "v",
        provider: "memory",
      });

      yield* executor.graphql.addSource({
        endpoint: "http://localhost:4000/graphql",
        scope: TEST_SCOPE,
        introspectionJson,
        namespace: "ref",
        headers: { "X-Token": { kind: "secret" } },
      });
      yield* executor.sources.configure({
        source: { id: "ref", scope: ScopeId.make(TEST_SCOPE) },
        scope: ScopeId.make(TEST_SCOPE),
        type: "graphql",
        config: { headers: { "X-Token": { kind: "secret", secretId: "locked" } } },
      });

      const result = yield* executor.secrets
        .remove(
          RemoveSecretInput.make({
            id: SecretId.make("locked"),
            targetScope: ScopeId.make(TEST_SCOPE),
          }),
        )
        .pipe(
          Effect.as("removed"),
          Effect.catchTag("SecretInUseError", () => Effect.succeed("SecretInUseError" as const)),
        );
      expect(result).toBe("SecretInUseError");

      // After detaching the source, remove succeeds.
      yield* executor.graphql.removeSource("ref", TEST_SCOPE);
      yield* executor.secrets.remove(
        RemoveSecretInput.make({
          id: SecretId.make("locked"),
          targetScope: ScopeId.make(TEST_SCOPE),
        }),
      );
    }),
  );

  it.effect("usagesForConnection returns one Usage per source", () =>
    Effect.gen(function* () {
      const executor = yield* createExecutor(
        makeTestConfig({
          plugins: [memorySecretsPlugin(), graphqlPlugin()] as const,
        }),
      );

      const connectionId = ConnectionId.make("graphql-conn");
      yield* executor.connections.create(
        CreateConnectionInput.make({
          id: connectionId,
          scope: ScopeId.make(TEST_SCOPE),
          provider: "oauth2",
          identityLabel: "Conn",
          accessToken: TokenMaterial.make({
            secretId: SecretId.make(`${connectionId}.access_token`),
            name: "Access Token",
            value: "tok",
          }),
          refreshToken: null,
          expiresAt: null,
          oauthScope: null,
          providerState: null,
        }),
      );

      yield* executor.graphql.addSource({
        endpoint: "http://localhost:4000/graphql",
        scope: TEST_SCOPE,
        introspectionJson,
        namespace: "oauth_ref",
        oauth2: graphqlOAuth2Config,
      });
      yield* executor.sources.configure({
        source: { id: "oauth_ref", scope: ScopeId.make(TEST_SCOPE) },
        scope: ScopeId.make(TEST_SCOPE),
        type: "graphql",
        config: {
          auth: {
            oauth2: {
              connection: { kind: "connection", connectionId },
            },
          },
        },
      });

      const usages = yield* executor.connections.usages(connectionId);
      expect(usages.length).toBe(1);
      expect(usages[0]).toMatchObject({
        pluginId: "graphql",
        ownerKind: "credential-binding",
        ownerId: "oauth_ref",
        slot: "auth:oauth2:connection",
      });
    }),
  );
});

describe("graphqlPlugin detect URL-token fallback", () => {
  // Port 1 connection-refuses immediately, so introspection always
  // fails and the URL-token fallback is the only thing that can
  // produce a candidate.
  it.effect("returns low-confidence candidate when path has /graphql segment", () =>
    Effect.gen(function* () {
      const executor = yield* createExecutor(
        makeTestConfig({ plugins: [graphqlPlugin()] as const }),
      );
      const results = yield* executor.sources.detect("http://127.0.0.1:1/api/graphql");
      const gql = results.find((r) => r.kind === "graphql");
      expect(gql).toBeDefined();
      expect(gql?.confidence).toBe("low");
    }),
  );

  it.effect("matches graphql on hostname label", () =>
    Effect.gen(function* () {
      const executor = yield* createExecutor(
        makeTestConfig({ plugins: [graphqlPlugin()] as const }),
      );
      const results = yield* executor.sources.detect("http://graphql.127.0.0.1.nip.io:1/");
      const gql = results.find((r) => r.kind === "graphql");
      expect(gql?.confidence).toBe("low");
    }),
  );

  it.effect("does not match graphql as a substring", () =>
    Effect.gen(function* () {
      const executor = yield* createExecutor(
        makeTestConfig({ plugins: [graphqlPlugin()] as const }),
      );
      const results = yield* executor.sources.detect("http://127.0.0.1:1/graphqlite");
      expect(results.find((r) => r.kind === "graphql")).toBeUndefined();
    }),
  );

  it.effect("returns null when no token match and introspection fails", () =>
    Effect.gen(function* () {
      const executor = yield* createExecutor(
        makeTestConfig({ plugins: [graphqlPlugin()] as const }),
      );
      const results = yield* executor.sources.detect("http://127.0.0.1:1/api/v1");
      expect(results.find((r) => r.kind === "graphql")).toBeUndefined();
    }),
  );
});
