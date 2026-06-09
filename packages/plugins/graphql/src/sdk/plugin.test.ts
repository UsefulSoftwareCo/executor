import { describe, it, expect } from "@effect/vitest";
import { Effect } from "effect";
import { HttpServerRequest, HttpServerResponse } from "effect/unstable/http";

import {
  AuthTemplateSlug,
  ConnectionName,
  IntegrationSlug,
  ProviderItemId,
  ProviderKey,
  ToolAddress,
  createExecutor,
} from "@executor-js/sdk";
import {
  makeTestConfig,
  serveTestHttpApp,
  memoryCredentialsPlugin,
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

// removed: v1 secret browser-handoff, credential-binding scopes, usagesForSecret/
// usagesForConnection, multi-scope shadowing, and `executor.sources.*` /
// `executor.secrets.*` flows — those surfaces no longer exist in the v2 model
// (secrets / sources / scope stack / credential bindings are gone). Coverage is
// ported to the v2 surface: integrations.register via `graphql.addIntegration`,
// per-connection tool production via `connections.create` -> resolveTools, and
// auth-template rendering in `invokeTool`.

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

const makeExecutor = () =>
  createExecutor(
    makeTestConfig({ plugins: [memoryCredentialsPlugin(), graphqlPlugin()] as const }),
  );

const toolAddr = (integration: string, connection: string, tool: string): ToolAddress =>
  ToolAddress.make(`tools.${integration}.org.${connection}.${tool}`);

const createOrgConnection = (
  executor: Awaited<ReturnType<typeof makeExecutor>> extends Effect.Effect<infer A> ? A : never,
  input: {
    readonly integration: string;
    readonly name: string;
    readonly template: string;
    readonly value: string;
  },
) =>
  executor.connections.create({
    owner: "org",
    name: ConnectionName.make(input.name),
    integration: IntegrationSlug.make(input.integration),
    template: AuthTemplateSlug.make(input.template),
    value: input.value,
  });

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

  it.effect("registers without a network call and introspects at connection-create", () =>
    Effect.gen(function* () {
      const server = yield* serveGreetingServer;
      const executor = yield* makeExecutor();

      // Registering a source is a catalog statement, not a network call: with no
      // pre-supplied schema, add makes zero requests and yields zero tools.
      const result = yield* executor.graphql.addIntegration({
        endpoint: server.endpoint,
        slug: "live_graph",
        name: "Live Graph",
      });

      expect(result).toMatchObject({ slug: "live_graph", toolCount: 0 });

      const addRequests = yield* server.requests;
      expect(addRequests.length).toBe(0);

      // Creating a connection is where introspection happens (like MCP defers
      // discovery to connect time) and materializes the per-connection tools.
      yield* createOrgConnection(executor, {
        integration: "live_graph",
        name: "default",
        template: "none",
        value: "unused",
      });

      const afterConnect = yield* server.requests;
      expect(afterConnect.some((request) => request.payload.query?.includes("__schema"))).toBe(
        true,
      );

      const tools = yield* executor.tools.list();
      expect(tools.map((tool) => String(tool.name))).toEqual(
        expect.arrayContaining(["query.hello", "mutation.setGreeting"]),
      );
    }),
  );

  it.effect("invokes a live query through an apiKey header template", () =>
    Effect.gen(function* () {
      const server = yield* serveGreetingServer;
      const executor = yield* makeExecutor();

      yield* executor.graphql.addIntegration({
        endpoint: server.endpoint,
        slug: "live_invoke",
        queryParams: { trace: "on" },
        authenticationTemplate: [
          { kind: "apiKey", slug: "header", in: "header", name: "x-static" },
        ],
      });
      yield* createOrgConnection(executor, {
        integration: "live_invoke",
        name: "main",
        template: "header",
        value: "abc",
      });

      // First invoke materializes operation bindings (one introspection) and runs
      // the query. Drive a second invoke against the now-warm cache so the query
      // request is the only thing on the wire and the assertions stay precise.
      yield* executor.execute(toolAddr("live_invoke", "main", "query.hello"), { name: "Ada" });
      yield* server.clearRequests;

      const result = yield* executor.execute(toolAddr("live_invoke", "main", "query.hello"), {
        name: "Ada",
      });

      expect(result).toEqual({ ok: true, data: { hello: "Hello Ada" } });

      const requests = yield* server.requests;
      expect(requests.length).toBe(1);
      expect(requests[0]?.headers["x-static"]).toBe("abc");
      expect(new URL(requests[0]!.url).searchParams.get("trace")).toBe("on");
      expect(requests[0]?.payload.variables).toEqual({ name: "Ada" });
    }),
  );

  it.effect("sends named operations derived from the field name", () =>
    Effect.gen(function* () {
      const server = yield* serveGreetingServer;
      const executor = yield* makeExecutor();

      yield* executor.graphql.addIntegration({
        endpoint: server.endpoint,
        slug: "named_ops",
      });
      yield* createOrgConnection(executor, {
        integration: "named_ops",
        name: "main",
        template: "none",
        value: "unused",
      });

      yield* executor.execute(toolAddr("named_ops", "main", "query.hello"), { name: "Ada" });
      yield* server.clearRequests;

      yield* executor.execute(toolAddr("named_ops", "main", "query.hello"), { name: "Ada" });
      yield* executor.execute(toolAddr("named_ops", "main", "mutation.setGreeting"), {
        message: "hi",
      });

      const requests = yield* server.requests;
      expect(requests[0]?.payload.query).toMatch(/^query Hello\b/);
      expect(requests[1]?.payload.query).toMatch(/^mutation SetGreeting\b/);
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
      const executor = yield* makeExecutor();

      yield* executor.graphql.addIntegration({
        endpoint: server.url("/graphql"),
        slug: "http_error_graph",
      });
      yield* createOrgConnection(executor, {
        integration: "http_error_graph",
        name: "main",
        template: "none",
        value: "unused",
      });

      const result = yield* executor.execute(toolAddr("http_error_graph", "main", "query.hello"), {
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

  it.effect("invokes OAuth-backed integrations with a rendered bearer token", () =>
    Effect.gen(function* () {
      const server = yield* serveGraphqlTestServer({
        schema: makeGreetingGraphqlSchema(),
        auth: {
          validateAuthorization: (authorization) =>
            Effect.succeed(authorization === "Bearer secret-token"),
        },
      });
      const executor = yield* makeExecutor();

      yield* executor.graphql.addIntegration({
        endpoint: server.endpoint,
        slug: "oauth_graph",
        introspectionJson,
        authenticationTemplate: [{ kind: "oauth2", slug: "oauth2" }],
      });
      yield* createOrgConnection(executor, {
        integration: "oauth_graph",
        name: "main",
        template: "oauth2",
        value: "secret-token",
      });
      yield* server.clearRequests;

      const result = yield* executor.execute(toolAddr("oauth_graph", "main", "query.hello"), {
        name: "Ada",
      });

      expect(result).toEqual({ ok: true, data: { hello: "Hello Ada" } });

      const requests = yield* server.requests;
      expect(requests[0]?.headers.authorization).toBe("Bearer secret-token");
    }),
  );

  it.effect("defers introspection: add makes no network call, connect introspects", () =>
    Effect.gen(function* () {
      // Model an auth-required endpoint (e.g. GitHub): introspection without a
      // credential is rejected. Registering must NOT introspect, so add cannot
      // fail on auth; the credentialed introspection happens at connect time.
      const server = yield* serveGraphqlTestServer({
        schema: makeGreetingGraphqlSchema(),
        auth: {
          validateAuthorization: (authorization) =>
            Effect.succeed(authorization === "Bearer connect-token"),
        },
      });
      const executor = yield* makeExecutor();

      // 1) Add to catalog with no add-time credential → no network call, 0 tools.
      const added = yield* executor.graphql.addIntegration({
        endpoint: server.endpoint,
        slug: "deferred_auth",
        authenticationTemplate: [{ kind: "oauth2", slug: "oauth2" }],
      });
      expect(added).toMatchObject({ slug: "deferred_auth", toolCount: 0 });

      const afterAdd = yield* server.requests;
      expect(afterAdd.length).toBe(0);

      // 2) Connection-create introspects WITH the connection's credential. The
      // introspection request carries the rendered bearer and is accepted.
      yield* createOrgConnection(executor, {
        integration: "deferred_auth",
        name: "main",
        template: "oauth2",
        value: "connect-token",
      });

      const afterConnect = yield* server.requests;
      const introspectionRequests = afterConnect.filter((request) =>
        request.payload.query?.includes("__schema"),
      );
      expect(introspectionRequests.length).toBeGreaterThan(0);
      expect(introspectionRequests[0]?.headers.authorization).toBe("Bearer connect-token");

      // The introspected operations become per-connection tools.
      const tools = yield* executor.tools.list();
      const names = tools
        .filter((tool) => String(tool.integration) === "deferred_auth")
        .map((tool) => String(tool.name));
      expect(names).toContain("query.hello");
      expect(names).toContain("mutation.setGreeting");
    }),
  );
});

describe("graphqlPlugin", () => {
  it.effect("registers tools per-connection from introspection JSON", () =>
    Effect.gen(function* () {
      const executor = yield* makeExecutor();

      const result = yield* executor.graphql.addIntegration({
        endpoint: "http://localhost:4000/graphql",
        slug: "test_api",
        introspectionJson,
      });
      expect(result.toolCount).toBe(2);
      expect(result.slug).toBe("test_api");

      yield* createOrgConnection(executor, {
        integration: "test_api",
        name: "main",
        template: "none",
        value: "unused",
      });

      const tools = yield* executor.tools.list();
      const names = tools
        .filter((t) => String(t.integration) === "test_api")
        .map((t) => String(t.name));
      expect(names).toContain("query.hello");
      expect(names).toContain("mutation.setGreeting");

      // removed: v1 asserted the static `executor.graphql.*` tool was part of
      // `tools.list` / `tools.schema`. In v2 those surfaces return only the
      // per-connection catalog; static management tools are invoked by fqid via
      // `execute` and are not schema-introspectable.

      const queryTool = tools.find(
        (t) => String(t.integration) === "test_api" && String(t.name) === "query.hello",
      );
      expect(queryTool?.description).toBe("Say hello");

      const mutationTool = tools.find(
        (t) => String(t.integration) === "test_api" && String(t.name) === "mutation.setGreeting",
      );
      expect(mutationTool?.description).toBe("Set greeting message");
    }),
  );

  it.effect("removes an integration and its connections drop its tools", () =>
    Effect.gen(function* () {
      const executor = yield* makeExecutor();

      yield* executor.graphql.addIntegration({
        endpoint: "http://localhost:4000/graphql",
        slug: "removable",
        introspectionJson,
      });
      yield* createOrgConnection(executor, {
        integration: "removable",
        name: "main",
        template: "none",
        value: "unused",
      });

      let tools = yield* executor.tools.list();
      expect(tools.filter((t) => String(t.integration) === "removable").length).toBe(2);

      yield* executor.connections.remove({
        owner: "org",
        name: ConnectionName.make("main"),
        integration: IntegrationSlug.make("removable"),
      });
      yield* executor.graphql.removeIntegration("removable");

      tools = yield* executor.tools.list();
      expect(tools.filter((t) => String(t.integration) === "removable").length).toBe(0);

      const integration = yield* executor.integrations.get(IntegrationSlug.make("removable"));
      expect(integration).toBeNull();
    }),
  );

  it.effect("lists the registered integration in the catalog", () =>
    Effect.gen(function* () {
      const executor = yield* makeExecutor();

      yield* executor.graphql.addIntegration({
        endpoint: "http://localhost:4000/graphql",
        slug: "my_gql",
        name: "My GraphQL",
        introspectionJson,
      });

      const integrations = yield* executor.integrations.list();
      const dynamic = integrations.find((s) => String(s.slug) === "my_gql");
      expect(dynamic).toBeDefined();
      expect(dynamic!.kind).toBe("graphql");
      expect(dynamic!.canRemove).toBe(true);
      expect(dynamic!.canRefresh).toBe(true);
    }),
  );

  it.effect("mutations require approval via resolveTools annotations", () =>
    Effect.gen(function* () {
      const executor = yield* makeExecutor();

      yield* executor.graphql.addIntegration({
        endpoint: "http://localhost:4000/graphql",
        slug: "approval_test",
        introspectionJson,
      });
      yield* createOrgConnection(executor, {
        integration: "approval_test",
        name: "main",
        template: "none",
        value: "unused",
      });

      const tools = yield* executor.tools.list();
      const mutationTool = tools.find(
        (t) =>
          String(t.integration) === "approval_test" && String(t.name) === "mutation.setGreeting",
      );
      expect(mutationTool).toBeDefined();
      expect(mutationTool!.annotations?.requiresApproval).toBe(true);
      expect(mutationTool!.annotations?.approvalDescription).toBe("mutation setGreeting");

      const queryTool = tools.find(
        (t) => String(t.integration) === "approval_test" && String(t.name) === "query.hello",
      );
      expect(queryTool).toBeDefined();
      expect(queryTool!.annotations?.requiresApproval).toBeFalsy();
    }),
  );

  it.effect("graphql.configure patches the endpoint without re-registering", () =>
    Effect.gen(function* () {
      const executor = yield* makeExecutor();

      yield* executor.graphql.addIntegration({
        endpoint: "http://localhost:4000/graphql",
        slug: "patched",
        introspectionJson,
      });

      yield* executor.graphql.configure("patched", {
        endpoint: "http://localhost:5000/graphql",
        headers: { "x-custom": "abc" },
      });

      const config = yield* executor.graphql.getIntegration("patched");
      expect(config).toMatchObject({
        endpoint: "http://localhost:5000/graphql",
        headers: { "x-custom": "abc" },
      });
    }),
  );

  it.effect("static executor.graphql.addIntegration delegates to the extension", () =>
    Effect.gen(function* () {
      const executor = yield* makeExecutor();

      const result = yield* executor.execute(
        ToolAddress.make("executor.graphql.addIntegration"),
        {
          endpoint: "http://localhost:4000/graphql",
          slug: "via_static",
          name: "Via Static",
          introspectionJson,
        },
        { onElicitation: "accept-all" },
      );
      expect(result).toMatchObject({
        ok: true,
        data: { slug: "via_static", name: "Via Static" },
      });

      const integration = yield* executor.integrations.get(IntegrationSlug.make("via_static"));
      expect(integration).not.toBeNull();
    }),
  );

  it.effect("static executor.graphql.addIntegration registers an unreachable endpoint", () =>
    Effect.gen(function* () {
      const config = makeTestConfig({
        plugins: [memoryCredentialsPlugin(), graphqlPlugin()] as const,
      });
      const executor = yield* createExecutor(config);

      // Registering a source must not introspect — so an unreachable endpoint
      // (no add-time credential, e.g. GitHub) registers cleanly instead of
      // 4xx-ing on a network call. Introspection is deferred to connect/invoke.
      const result = yield* executor.execute(
        ToolAddress.make("executor.graphql.addIntegration"),
        {
          endpoint: "http://127.0.0.1:1/graphql",
          slug: "deferred_graphql",
          name: "Deferred GraphQL",
        },
        { onElicitation: "accept-all" },
      );

      expect(result).toMatchObject({
        ok: true,
        data: { slug: "deferred_graphql", name: "Deferred GraphQL" },
      });

      yield* executor.close();
      yield* Effect.promise(() => config.testDb.close());
    }),
  );

  it.effect("static executor.graphql.addIntegration surfaces malformed introspection JSON", () =>
    Effect.gen(function* () {
      const executor = yield* makeExecutor();

      // The offline path (caller supplies `introspectionJson`) still validates
      // the schema without a network call, surfacing an actionable failure.
      const result = yield* executor.execute(
        ToolAddress.make("executor.graphql.addIntegration"),
        {
          endpoint: "http://127.0.0.1:1/graphql",
          slug: "malformed_graphql",
          name: "Malformed GraphQL",
          introspectionJson: "{ not valid json",
        },
        { onElicitation: "accept-all" },
      );

      expect(result).toMatchObject({
        ok: false,
        error: { code: "graphql_introspection_failed" },
      });
    }),
  );

  // removed: v1 "describes static addSource parameters from Standard Schema"
  // asserted `executor.tools.schema("executor.graphql.addSource")` returned a
  // TypeScript preview. In v2 `tools.schema` only resolves per-connection tool
  // rows (5-segment `tools.*` addresses); static management tools are no longer
  // schema-introspectable, so this case no longer applies.

  it.effect("returns an auth failure when an apiKey connection has no value", () =>
    Effect.gen(function* () {
      const server = yield* serveGreetingServer;
      const executor = yield* makeExecutor();

      yield* executor.graphql.addIntegration({
        endpoint: server.endpoint,
        slug: "auth_required",
        introspectionJson,
        authenticationTemplate: [
          {
            kind: "apiKey",
            slug: "header",
            in: "header",
            name: "Authorization",
            prefix: "Bearer ",
          },
        ],
      });
      // Create a connection that resolves to no value: reference a provider item
      // id the writable store never set.
      yield* executor.connections.create({
        owner: "org",
        name: ConnectionName.make("main"),
        integration: IntegrationSlug.make("auth_required"),
        template: AuthTemplateSlug.make("header"),
        from: { provider: ProviderKey.make("memory"), id: ProviderItemId.make("never-set") },
      });

      const result = yield* executor.execute(toolAddr("auth_required", "main", "query.hello"), {
        name: "Ada",
      });

      expect(result).toMatchObject({
        ok: false,
        error: {
          code: "connection_value_missing",
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
      const executor = yield* makeExecutor();
      const results = yield* executor.integrations.detect("http://127.0.0.1:1/api/graphql");
      const gql = results.find((r) => r.kind === "graphql");
      expect(gql).toBeDefined();
      expect(gql?.confidence).toBe("low");
    }),
  );

  it.effect("matches graphql on hostname label", () =>
    Effect.gen(function* () {
      const executor = yield* makeExecutor();
      const results = yield* executor.integrations.detect("http://graphql.127.0.0.1.nip.io:1/");
      const gql = results.find((r) => r.kind === "graphql");
      expect(gql?.confidence).toBe("low");
    }),
  );

  it.effect("does not match graphql as a substring", () =>
    Effect.gen(function* () {
      const executor = yield* makeExecutor();
      const results = yield* executor.integrations.detect("http://127.0.0.1:1/graphqlite");
      expect(results.find((r) => r.kind === "graphql")).toBeUndefined();
    }),
  );

  it.effect("returns null when no token match and introspection fails", () =>
    Effect.gen(function* () {
      const executor = yield* makeExecutor();
      const results = yield* executor.integrations.detect("http://127.0.0.1:1/api/v1");
      expect(results.find((r) => r.kind === "graphql")).toBeUndefined();
    }),
  );
});
