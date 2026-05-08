import { describe, it, expect } from "@effect/vitest";
import { Effect, Predicate } from "effect";

import {
  ConnectionId,
  CreateConnectionInput,
  createExecutor,
  definePlugin,
  ElicitationResponse,
  makeTestConfig,
  RemoveSecretInput,
  Scope,
  ScopeId,
  SecretId,
  TokenMaterial,
} from "@executor-js/sdk";
import { memorySecretsPlugin } from "@executor-js/sdk/testing";

import { graphqlPlugin } from "./plugin";
import { GraphqlSourceBindingInput, graphqlHeaderSlot, graphqlQueryParamSlot } from "./types";
import type { IntrospectionResult } from "./introspect";
import { makeGreetingGraphqlSchema, serveGraphqlTestServer } from "../testing";

const TEST_SCOPE = "test-scope";

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
const declineAll = () => Effect.succeed(new ElicitationResponse({ action: "decline" }));

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
        status: 200,
        data: { hello: "Hello Ada" },
        errors: null,
      });

      const requests = yield* server.requests;
      expect(requests.length).toBe(1);
      expect(requests[0]?.headers["x-static"]).toBe("abc");
      expect(new URL(requests[0]!.url).searchParams.get("token")).toBe("qp-token");
      expect(requests[0]?.payload.variables).toEqual({ name: "Ada" });
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
        new CreateConnectionInput({
          id: connectionId,
          scope: ScopeId.make(TEST_SCOPE),
          provider: "oauth2",
          identityLabel: "GraphQL Test",
          accessToken: new TokenMaterial({
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
        credentialTargetScope: TEST_SCOPE,
        auth: { kind: "oauth2", connectionId },
      });
      yield* server.clearRequests;

      const result = yield* executor.tools.invoke("oauth_graph.query.hello", {
        name: "Ada",
      });

      expect(result).toEqual({
        status: 200,
        data: { hello: "Hello Ada" },
        errors: null,
      });

      const requests = yield* server.requests;
      expect(requests[0]?.headers.authorization).toBe("Bearer secret-token");
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
      // static control tool also present
      expect(ids).toContain("graphql.addSource");

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

  it.effect("lists sources with the static control source", () =>
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

      const control = sources.find((s) => s.id === "graphql");
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

  it.effect("updateSource patches endpoint/headers without re-registering", () =>
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

      yield* executor.graphql.updateSource("patched", TEST_SCOPE, {
        endpoint: "http://localhost:5000/graphql",
        headers: { "x-custom": "abc" },
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

  it.effect("static graphql.addSource delegates to extension", () =>
    Effect.gen(function* () {
      const userScope = ScopeId.make("static-user");
      const orgScope = ScopeId.make("static-org");
      const executor = yield* createExecutor(
        makeTestConfig({
          scopes: [
            new Scope({ id: userScope, name: "user", createdAt: new Date() }),
            new Scope({ id: orgScope, name: "org", createdAt: new Date() }),
          ],
          plugins: [graphqlPlugin()] as const,
        }),
      );

      const result = yield* executor.tools.invoke(
        "graphql.addSource",
        {
          scope: String(orgScope),
          endpoint: "http://localhost:4000/graphql",
          introspectionJson,
          namespace: "via_static",
        },
        { onElicitation: "accept-all" },
      );
      expect(result).toEqual({ toolCount: 2, namespace: "via_static" });
      expect(yield* executor.graphql.getSource("via_static", String(userScope))).toBeNull();
      expect((yield* executor.graphql.getSource("via_static", String(orgScope)))?.scope).toBe(
        orgScope,
      );

      const tools = yield* executor.tools.list();
      expect(tools.filter((t) => t.sourceId === "via_static").length).toBe(2);
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
          "graphql.addSource",
          {
            endpoint: server.endpoint,
            scope: TEST_SCOPE,
            introspectionJson,
            namespace: "runtime_graphql",
          },
          { onElicitation: declineAll },
        )
        .pipe(Effect.flip);
      expect(Predicate.isTagged(declined, "ElicitationDeclinedError")).toBe(true);

      const requests = yield* server.requests;
      expect(
        requests.some((request) => request.payload.variables?.name === "sample-value"),
      ).toBe(false);
    }),
  );

  it.effect("applies source headers to the introspection request after approval", () =>
    Effect.gen(function* () {
      const server = yield* serveGreetingServer;
      const executor = yield* createExecutor(
        makeTestConfig({ plugins: [graphqlPlugin()] as const }),
      );

      yield* executor.tools.invoke(
        "graphql.addSource",
        {
          endpoint: server.endpoint,
          scope: TEST_SCOPE,
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
  // store reads/writes that don't pin scope_id collapse onto whichever row
  // the scoped adapter's `scope_id IN (stack)` filter sees first. Each
  // scenario is reproducible against the pre-fix store.
  // -------------------------------------------------------------------------

  const ORG_SCOPE = "org-scope";
  const USER_SCOPE = "user-scope";

  const stackedScopes = [
    new Scope({
      id: ScopeId.make(USER_SCOPE),
      name: "user",
      createdAt: new Date(),
    }),
    new Scope({
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

  it.effect("updateSource on user shadow does not mutate the org row", () =>
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

      yield* executor.graphql.updateSource("shared", USER_SCOPE, {
        name: "User Renamed",
        endpoint: "http://user-new.example.com/graphql",
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
          Authorization: { secretId: "org-token", prefix: "Bearer " },
        },
        queryParams: {
          token: { secretId: "org-query" },
        },
        credentialTargetScope: ORG_SCOPE,
      });

      yield* executor.graphql.setSourceBinding(
        new GraphqlSourceBindingInput({
          sourceId: "shared_credentials",
          sourceScope: ScopeId.make(ORG_SCOPE),
          scope: ScopeId.make(USER_SCOPE),
          slot: graphqlHeaderSlot("Authorization"),
          value: { kind: "secret", secretId: SecretId.make("user-token") },
        }),
      );
      yield* executor.graphql.setSourceBinding(
        new GraphqlSourceBindingInput({
          sourceId: "shared_credentials",
          sourceScope: ScopeId.make(ORG_SCOPE),
          scope: ScopeId.make(USER_SCOPE),
          slot: graphqlQueryParamSlot("token"),
          value: { kind: "secret", secretId: SecretId.make("user-query") },
        }),
      );

      yield* server.clearRequests;
      const result = yield* executor.tools.invoke("shared_credentials.query.hello", {
        name: "Ada",
      });

      expect(result).toMatchObject({
        status: 200,
        data: { hello: "Hello Ada" },
      });
      const requests = yield* server.requests;
      expect(requests[0]?.headers.authorization).toBe("Bearer user-secret");
      expect(new URL(requests[0]!.url).searchParams.get("token")).toBe("user-query-secret");
    }),
  );

  it.effect("addSource stores direct GraphQL credential bindings at each row scope", () =>
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
          Authorization: {
            secretId: "row-user-token",
            prefix: "Bearer ",
            targetScope: USER_SCOPE,
          },
        },
        queryParams: {
          token: {
            secretId: "row-org-query",
            targetScope: ORG_SCOPE,
          },
        },
      });

      const bindings = yield* executor.graphql.listSourceBindings(
        "row_scoped_credentials",
        ORG_SCOPE,
      );

      expect(bindings.map((binding) => binding.slot).sort()).toEqual([
        graphqlHeaderSlot("Authorization"),
        graphqlQueryParamSlot("token"),
      ]);
      expect(
        bindings.find((binding) => binding.slot === graphqlHeaderSlot("Authorization"))?.scopeId,
      ).toBe(ScopeId.make(USER_SCOPE));
      expect(
        bindings.find((binding) => binding.slot === graphqlQueryParamSlot("token"))?.scopeId,
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
          Authorization: { secretId: "shared-token", prefix: "Bearer " },
        },
        credentialTargetScope: ORG_SCOPE,
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
        status: 200,
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
          new CreateConnectionInput({
            id: connectionId,
            scope: ScopeId.make(ORG_SCOPE),
            provider: "oauth2",
            identityLabel: "Org connection",
            accessToken: new TokenMaterial({
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
          auth: { kind: "oauth2", connectionId },
          credentialTargetScope: ORG_SCOPE,
        });

        yield* executor.connections.create(
          new CreateConnectionInput({
            id: connectionId,
            scope: ScopeId.make(USER_SCOPE),
            provider: "oauth2",
            identityLabel: "User colliding connection",
            accessToken: new TokenMaterial({
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
          status: 200,
          data: { hello: "Hello Ada" },
        });
        const requests = yield* server.requests;
        expect(requests[0]?.headers.authorization).toBe("Bearer org-access-token");
      }),
  );

  it.effect("updateSource removes bindings for credential slots no longer present", () =>
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
        headers: { "X-Old": { secretId: "old-token" } },
        credentialTargetScope: ORG_SCOPE,
      });

      yield* executor.graphql.updateSource("stale_binding", ORG_SCOPE, {
        headers: {},
      });

      const bindings = yield* executor.graphql.listSourceBindings("stale_binding", ORG_SCOPE);
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
        credentialTargetScope: TEST_SCOPE,
        headers: {
          Authorization: { secretId: "api-key", prefix: "Bearer " },
        },
        queryParams: { token: { secretId: "api-key" } },
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
        credentialTargetScope: TEST_SCOPE,
        headers: { "X-Token": { secretId: "locked" } },
      });

      const result = yield* executor.secrets
        .remove(
          new RemoveSecretInput({
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
        new RemoveSecretInput({
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
        new CreateConnectionInput({
          id: connectionId,
          scope: ScopeId.make(TEST_SCOPE),
          provider: "oauth2",
          identityLabel: "Conn",
          accessToken: new TokenMaterial({
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
        credentialTargetScope: TEST_SCOPE,
        auth: { kind: "oauth2", connectionId },
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
