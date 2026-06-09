import { describe, it, expect } from "@effect/vitest";
import { Effect } from "effect";
import { HttpServerRequest, HttpServerResponse } from "effect/unstable/http";

import {
  AuthTemplateSlug,
  ConnectionName,
  createExecutor,
  IntegrationSlug,
  ToolAddress,
} from "@executor-js/sdk";
import {
  makeTestConfig,
  memoryCredentialsPlugin,
  serveTestHttpApp,
} from "@executor-js/sdk/testing";

import { graphqlPlugin } from "./plugin";
import { endpointForTelemetry } from "./invoke";
import { introspect } from "./introspect";
import type { IntrospectionResult } from "./introspect";
import {
  makeGreetingGraphqlSchema,
  serveGraphqlFailureTestServer,
  serveGraphqlTestServer,
} from "../testing";

// removed: v1's scope-stack, secret-table, and credential-binding tests
// (initial credential bindings, user-scoped org introspection, multi-scope
// shadowing add/remove/configure, org-vs-user secret/connection collision,
// `usagesForSecret`/`usagesForConnection`, `secrets.remove` refusal). v2 has no
// scope stack (owner is explicit in the address), no secret table, and no
// credential bindings — a connection IS the credential and resolves its value
// through a provider. The cases below cover the v2 surface: add integration,
// per-connection tool production, auth-template rendering at invoke, upstream
// failure reshaping, and URL detection.

const GRAPHQL = IntegrationSlug.make("greeting_graph");
const BEARER = AuthTemplateSlug.make("oauth");

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

describe("graphqlPlugin introspection error handling", () => {
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
});

describe("graphqlPlugin integration + connection lifecycle", () => {
  it.effect("adds an integration by introspecting the live GraphQL endpoint", () =>
    Effect.gen(function* () {
      const server = yield* serveGreetingServer;
      const executor = yield* createExecutor(
        makeTestConfig({ plugins: [memoryCredentialsPlugin(), graphqlPlugin()] as const }),
      );

      const result = yield* executor["graphql-greenfield"].addIntegration({
        slug: "live_graph",
        endpoint: server.endpoint,
      });
      expect(result).toEqual({ slug: "live_graph", toolCount: 2 });

      const requests = yield* server.requests;
      expect(requests.some((request) => request.payload.query?.includes("__schema"))).toBe(true);

      // A connection produces the integration's tools, addressed with its owner.
      yield* executor.connections.create({
        owner: "org",
        name: ConnectionName.make("main"),
        integration: IntegrationSlug.make("live_graph"),
        template: BEARER,
        value: "token",
      });

      const tools = yield* executor.tools.list();
      expect(
        tools
          .map((t) => String(t.address))
          .filter((address) => address.startsWith("tools.live_graph."))
          .sort(),
      ).toEqual([
        "tools.live_graph.org.main.mutation.setGreeting",
        "tools.live_graph.org.main.query.hello",
      ]);
    }),
  );

  it.effect("registers tools from introspection JSON", () =>
    Effect.gen(function* () {
      const executor = yield* createExecutor(
        makeTestConfig({ plugins: [memoryCredentialsPlugin(), graphqlPlugin()] as const }),
      );

      const result = yield* executor["graphql-greenfield"].addIntegration({
        slug: "test_api",
        endpoint: "http://localhost:4000/graphql",
        introspectionJson,
      });
      expect(result).toEqual({ slug: "test_api", toolCount: 2 });

      yield* executor.connections.create({
        owner: "org",
        name: ConnectionName.make("c"),
        integration: IntegrationSlug.make("test_api"),
        template: BEARER,
        value: "token",
      });

      const tools = yield* executor.tools.list();
      const byName = new Map(tools.map((t) => [String(t.name), t] as const));
      expect(byName.get("query.hello")?.description).toBe("Say hello");
      expect(byName.get("mutation.setGreeting")?.description).toBe("Set greeting message");
    }),
  );

  it.effect("mutations require approval; queries do not", () =>
    Effect.gen(function* () {
      const executor = yield* createExecutor(
        makeTestConfig({ plugins: [memoryCredentialsPlugin(), graphqlPlugin()] as const }),
      );

      yield* executor["graphql-greenfield"].addIntegration({
        slug: "approval_test",
        endpoint: "http://localhost:4000/graphql",
        introspectionJson,
      });
      yield* executor.connections.create({
        owner: "org",
        name: ConnectionName.make("c"),
        integration: IntegrationSlug.make("approval_test"),
        template: BEARER,
        value: "token",
      });

      const tools = yield* executor.tools.list();
      const mutationTool = tools.find((t) => String(t.name) === "mutation.setGreeting");
      expect(mutationTool?.annotations?.requiresApproval).toBe(true);
      expect(mutationTool?.annotations?.approvalDescription).toBe("mutation setGreeting");
      const queryTool = tools.find((t) => String(t.name) === "query.hello");
      expect(queryTool?.annotations?.requiresApproval).toBeFalsy();
    }),
  );

  it.effect("removing a connection removes its tools; the integration remains", () =>
    Effect.gen(function* () {
      const executor = yield* createExecutor(
        makeTestConfig({ plugins: [memoryCredentialsPlugin(), graphqlPlugin()] as const }),
      );

      yield* executor["graphql-greenfield"].addIntegration({
        slug: "removable",
        endpoint: "http://localhost:4000/graphql",
        introspectionJson,
      });
      yield* executor.connections.create({
        owner: "org",
        name: ConnectionName.make("c"),
        integration: IntegrationSlug.make("removable"),
        template: BEARER,
        value: "token",
      });

      const listRemovableToolAddresses = Effect.map(executor.tools.list(), (tools) =>
        tools
          .map((t) => String(t.address))
          .filter((address) => address.startsWith("tools.removable.")),
      );

      expect((yield* listRemovableToolAddresses).length).toBe(2);

      yield* executor.connections.remove({
        owner: "org",
        integration: IntegrationSlug.make("removable"),
        name: ConnectionName.make("c"),
      });

      expect(yield* listRemovableToolAddresses).toEqual([]);
      // Integration is still in the catalog.
      const integration = yield* executor.integrations.get(IntegrationSlug.make("removable"));
      expect(integration?.kind).toBe("graphql-greenfield");
    }),
  );
});

describe("graphqlPlugin invocation", () => {
  it.effect("renders the connection value as a bearer header and invokes the query", () =>
    Effect.gen(function* () {
      const server = yield* serveGraphqlTestServer({
        schema: makeGreetingGraphqlSchema(),
        auth: {
          validateAuthorization: (authorization) =>
            Effect.succeed(authorization === "Bearer secret-token"),
        },
      });
      const executor = yield* createExecutor(
        makeTestConfig({ plugins: [memoryCredentialsPlugin(), graphqlPlugin()] as const }),
      );

      yield* executor["graphql-greenfield"].addIntegration({
        slug: GRAPHQL,
        endpoint: server.endpoint,
        introspectionHeaders: { Authorization: "Bearer secret-token" },
      });
      yield* executor.connections.create({
        owner: "org",
        name: ConnectionName.make("main"),
        integration: GRAPHQL,
        template: BEARER,
        value: "secret-token",
      });
      yield* server.clearRequests;

      const result = yield* executor.execute(
        ToolAddress.make("tools.greeting_graph.org.main.query.hello"),
        { name: "Ada" },
      );
      expect(result).toEqual({ ok: true, data: { hello: "Hello Ada" } });

      const requests = yield* server.requests;
      expect(requests[0]?.headers.authorization).toBe("Bearer secret-token");
      expect(requests[0]?.payload.variables).toEqual({ name: "Ada" });
    }),
  );

  it.effect("renders an apiKey header template with a prefix", () =>
    Effect.gen(function* () {
      const server = yield* serveGraphqlTestServer({
        schema: makeGreetingGraphqlSchema(),
        auth: {
          validateAuthorization: (authorization) =>
            Effect.succeed(authorization === "token abc123"),
        },
      });
      const executor = yield* createExecutor(
        makeTestConfig({ plugins: [memoryCredentialsPlugin(), graphqlPlugin()] as const }),
      );

      yield* executor["graphql-greenfield"].addIntegration({
        slug: "apikey_graph",
        endpoint: server.endpoint,
        introspectionHeaders: { Authorization: "token abc123" },
        authentication: [
          {
            slug: "apiKey",
            type: "apiKey",
            in: "header",
            name: "Authorization",
            prefix: "token ",
          },
        ],
      });
      yield* executor.connections.create({
        owner: "org",
        name: ConnectionName.make("main"),
        integration: IntegrationSlug.make("apikey_graph"),
        template: AuthTemplateSlug.make("apiKey"),
        value: "abc123",
      });
      yield* server.clearRequests;

      const result = yield* executor.execute(
        ToolAddress.make("tools.apikey_graph.org.main.query.hello"),
        { name: "Ada" },
      );
      expect(result).toEqual({ ok: true, data: { hello: "Hello Ada" } });
      const requests = yield* server.requests;
      expect(requests[0]?.headers.authorization).toBe("token abc123");
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
        }).pipe(Effect.orDie),
      );
      const executor = yield* createExecutor(
        makeTestConfig({ plugins: [memoryCredentialsPlugin(), graphqlPlugin()] as const }),
      );

      yield* executor["graphql-greenfield"].addIntegration({
        slug: "http_error_graph",
        endpoint: server.url("/graphql"),
      });
      yield* executor.connections.create({
        owner: "org",
        name: ConnectionName.make("c"),
        integration: IntegrationSlug.make("http_error_graph"),
        template: BEARER,
        value: "token",
      });

      const result = yield* executor.execute(
        ToolAddress.make("tools.http_error_graph.org.c.query.hello"),
        { name: "Ada" },
      );

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

  it.effect("reshapes a 401 upstream rejection into an auth failure", () =>
    Effect.gen(function* () {
      const server = yield* serveTestHttpApp((request) =>
        Effect.gen(function* () {
          const webRequest = yield* HttpServerRequest.toWeb(request);
          const body = yield* Effect.promise(() => webRequest.text());
          if (body.includes("__schema")) {
            return HttpServerResponse.jsonUnsafe({ data: introspectionResult });
          }
          // A non-GraphQL 401 (no `errors` array) so the upstream-rejection
          // branch — not the GraphQL-errors branch — reshapes it.
          return HttpServerResponse.text("Unauthorized", {
            status: 401,
            contentType: "text/plain",
          });
        }).pipe(Effect.orDie),
      );
      const executor = yield* createExecutor(
        makeTestConfig({ plugins: [memoryCredentialsPlugin(), graphqlPlugin()] as const }),
      );

      yield* executor["graphql-greenfield"].addIntegration({
        slug: "rejected_graph",
        endpoint: server.url("/graphql"),
      });
      yield* executor.connections.create({
        owner: "org",
        name: ConnectionName.make("c"),
        integration: IntegrationSlug.make("rejected_graph"),
        template: BEARER,
        value: "stale-token",
      });

      const result = yield* executor.execute(
        ToolAddress.make("tools.rejected_graph.org.c.query.hello"),
        { name: "Ada" },
      );

      expect(result).toMatchObject({
        ok: false,
        error: {
          code: "connection_rejected",
          status: 401,
          details: { category: "authentication" },
        },
      });
    }),
  );
});

describe("graphqlPlugin detect URL-token fallback", () => {
  // Port 1 connection-refuses immediately, so introspection always fails and
  // the URL-token fallback is the only thing that can produce a candidate.
  it.effect("returns low-confidence candidate when path has /graphql segment", () =>
    Effect.gen(function* () {
      const executor = yield* createExecutor(
        makeTestConfig({ plugins: [memoryCredentialsPlugin(), graphqlPlugin()] as const }),
      );
      const results = yield* executor.integrations.detect("http://127.0.0.1:1/api/graphql");
      const gql = results.find((r) => r.kind === "graphql");
      expect(gql?.confidence).toBe("low");
    }),
  );

  it.effect("does not match graphql as a substring", () =>
    Effect.gen(function* () {
      const executor = yield* createExecutor(
        makeTestConfig({ plugins: [memoryCredentialsPlugin(), graphqlPlugin()] as const }),
      );
      const results = yield* executor.integrations.detect("http://127.0.0.1:1/graphqlite");
      expect(results.find((r) => r.kind === "graphql")).toBeUndefined();
    }),
  );

  it.effect("returns null when no token match and introspection fails", () =>
    Effect.gen(function* () {
      const executor = yield* createExecutor(
        makeTestConfig({ plugins: [memoryCredentialsPlugin(), graphqlPlugin()] as const }),
      );
      const results = yield* executor.integrations.detect("http://127.0.0.1:1/api/v1");
      expect(results.find((r) => r.kind === "graphql")).toBeUndefined();
    }),
  );
});
