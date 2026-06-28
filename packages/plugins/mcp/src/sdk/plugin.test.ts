import { describe, expect, it } from "@effect/vitest";
import { Effect, Layer, Option, Predicate, Schema } from "effect";
import {
  HttpClient,
  HttpClientRequest,
  HttpClientResponse,
  HttpServerResponse,
} from "effect/unstable/http";

import {
  AuthTemplateSlug,
  ConnectionName,
  IntegrationSlug,
  OAuthClientSlug,
  ToolAddress,
  createExecutor,
} from "@executor-js/sdk";
import {
  makeTestConfig,
  memoryCredentialsPlugin,
  scopesFromAuthorizeUrl,
  serveOAuthTestServer,
  serveTestHttpApp,
} from "@executor-js/sdk/testing";

import { createMcpConnector } from "./connection";
import { mcpPlugin, userFacingProbeMessage } from "./plugin";
import { McpInvocationError } from "./errors";
import { extractManifestFromListToolsResult, deriveMcpNamespace, joinToolPath } from "./manifest";
import { makeAnnotationsMcpServer, serveMcpServer } from "../testing";

// removed: the v1 addSource / scopes / secrets / credential-binding / usages /
// sources.configure / multi-scope shadowing suites. v2 has no scope stack, no
// secrets table, and no credential bindings — an MCP server is registered as an
// integration (`addServer`) and a connection IS the credential (created via
// `connections.create` / `oauth.start`). Owner isolation is covered by
// owner-isolation.test.ts; the end-to-end auth/header path is covered by
// elicitation.test.ts + owner-isolation.test.ts.

const TEMPLATE = AuthTemplateSlug.make("none");

const JsonRpcId = Schema.Union([Schema.String, Schema.Number, Schema.Null]);
const JsonRpcRequest = Schema.Struct({
  id: Schema.optional(JsonRpcId),
  method: Schema.String,
});
type JsonRpcRequest = typeof JsonRpcRequest.Type;

const decodeJsonRpcRequest = Schema.decodeUnknownOption(Schema.fromJsonString(JsonRpcRequest));

const jsonRpcResult = (request: JsonRpcRequest, result: unknown) =>
  HttpServerResponse.jsonUnsafe({
    jsonrpc: "2.0",
    id: request.id ?? null,
    result,
  });

// The call-tool fixtures share one JSON-RPC scaffold (handshake, tool listing,
// unknown-method rejection); only the `tools/call` response varies. Each
// scenario supplies that branch via a `CallToolResponder`.
type CallToolResponder = (rpc: JsonRpcRequest) => ReturnType<typeof HttpServerResponse.text>;

const callToolFixtureResponse = (rpc: JsonRpcRequest, callTool: CallToolResponder) => {
  if (rpc.method === "initialize") {
    return jsonRpcResult(rpc, {
      protocolVersion: "2025-06-18",
      capabilities: { tools: {} },
      serverInfo: { name: "call-tool-fixture", version: "1.0.0" },
    });
  }
  if (rpc.method === "notifications/initialized") {
    return HttpServerResponse.text("", { status: 202 });
  }
  if (rpc.method === "tools/list") {
    return jsonRpcResult(rpc, {
      tools: [
        {
          name: "explode",
          description: "Returns a failure from tools/call",
          inputSchema: { type: "object", properties: {} },
        },
      ],
    });
  }
  if (rpc.method === "tools/call") {
    return callTool(rpc);
  }
  return HttpServerResponse.text("Unexpected JSON-RPC method", { status: 400 });
};

const serveCallToolServer = (callTool: CallToolResponder) =>
  serveTestHttpApp((request) =>
    Effect.gen(function* () {
      if (request.method === "GET") {
        return HttpServerResponse.text("SSE disabled", { status: 405 });
      }

      const body = yield* request.text.pipe(Effect.orDie);
      return Option.match(decodeJsonRpcRequest(body), {
        onNone: () => HttpServerResponse.text("Invalid JSON-RPC fixture request", { status: 400 }),
        onSome: (rpc) => callToolFixtureResponse(rpc, callTool),
      });
    }),
  );

// `tools/call` responders. Both embed a "do-not-leak" sentinel the assertions
// confirm never reaches the caller-facing failure.
const httpStatusCallTool =
  (status: number): CallToolResponder =>
  () =>
    HttpServerResponse.text("do-not-leak: upstream auth challenge", { status });

const jsonRpcErrorCallTool =
  (code: number): CallToolResponder =>
  (rpc) =>
    HttpServerResponse.jsonUnsafe({
      jsonrpc: "2.0",
      id: rpc.id ?? null,
      error: { code, message: "application-level do-not-leak" },
    });

const seedCallToolExecutor = (input: { slug: string; callTool: CallToolResponder }) =>
  Effect.acquireRelease(
    Effect.gen(function* () {
      const server = yield* serveCallToolServer(input.callTool);
      const config = makeTestConfig({
        plugins: [memoryCredentialsPlugin(), mcpPlugin()] as const,
      });
      const executor = yield* createExecutor(config);

      yield* executor.mcp.addServer({
        name: "Call tool fixture",
        endpoint: server.url("/mcp"),
        slug: input.slug,
        remoteTransport: "streamable-http",
      });
      yield* executor.connections.create({
        owner: "org",
        name: ConnectionName.make("main"),
        integration: IntegrationSlug.make(input.slug),
        template: TEMPLATE,
        value: "",
      });

      return {
        config,
        executor,
        toolAddress: ToolAddress.make(`tools.${input.slug}.org.main.explode`),
      } as const;
    }),
    ({ config, executor }) =>
      Effect.gen(function* () {
        yield* executor.close().pipe(Effect.ignore);
        yield* Effect.promise(() => config.testDb.close()).pipe(Effect.ignore);
      }),
  );

// ---------------------------------------------------------------------------
// Manifest extraction
// ---------------------------------------------------------------------------

describe("extractManifestFromListToolsResult", () => {
  it.effect("extracts tools from a valid listTools response", () =>
    Effect.sync(() => {
      const result = extractManifestFromListToolsResult({
        tools: [
          {
            name: "get_weather",
            description: "Get weather for a location",
            inputSchema: {
              type: "object",
              properties: { location: { type: "string" } },
            },
          },
          { name: "search", description: "Search the web" },
        ],
      });

      expect(result.tools).toHaveLength(2);
      expect(result.tools[0]!.toolName).toBe("get_weather");
      expect(result.tools[0]!.toolId).toBe("get_weather");
      expect(result.tools[0]!.description).toBe("Get weather for a location");
      expect(result.tools[1]!.toolName).toBe("search");
    }),
  );

  it.effect("sanitizes tool IDs", () =>
    Effect.sync(() => {
      const result = extractManifestFromListToolsResult({
        tools: [
          { name: "My Tool!!", description: null },
          { name: "My Tool!!", description: null },
        ],
      });

      expect(result.tools[0]!.toolId).toBe("my_tool");
      expect(result.tools[1]!.toolId).toBe("my_tool_2");
    }),
  );

  it.effect("handles empty tools list", () =>
    Effect.sync(() => {
      const result = extractManifestFromListToolsResult({ tools: [] });
      expect(result.tools).toHaveLength(0);
    }),
  );

  it.effect("extracts server metadata", () =>
    Effect.sync(() => {
      const result = extractManifestFromListToolsResult(
        { tools: [] },
        { serverInfo: { name: "test-server", version: "1.0.0" } },
      );
      expect(result.server?.name).toBe("test-server");
      expect(result.server?.version).toBe("1.0.0");
    }),
  );

  it.effect("decodes upstream tool annotations", () =>
    Effect.sync(() => {
      const result = extractManifestFromListToolsResult({
        tools: [
          { name: "delete", annotations: { destructiveHint: true } },
          { name: "list", annotations: { readOnlyHint: true } },
          { name: "ping" },
        ],
      });

      expect(result.tools[0]!.annotations?.destructiveHint).toBe(true);
      expect(result.tools[1]!.annotations?.readOnlyHint).toBe(true);
      expect(result.tools[2]!.annotations).toBeUndefined();
    }),
  );
});

// ---------------------------------------------------------------------------
// Namespace derivation
// ---------------------------------------------------------------------------

describe("deriveMcpNamespace", () => {
  it.effect("derives from name", () =>
    Effect.sync(() => {
      expect(deriveMcpNamespace({ name: "GitHub MCP" })).toBe("github_mcp");
    }),
  );

  it.effect("derives from endpoint", () =>
    Effect.sync(() => {
      expect(deriveMcpNamespace({ endpoint: "https://api.example.com/mcp" })).toBe(
        "api_example_com",
      );
    }),
  );

  it.effect("derives from command", () =>
    Effect.sync(() => {
      expect(deriveMcpNamespace({ command: "/usr/local/bin/my-mcp-server" })).toBe("my_mcp_server");
    }),
  );

  it.effect("falls back to 'mcp'", () =>
    Effect.sync(() => {
      expect(deriveMcpNamespace({})).toBe("mcp");
    }),
  );
});

// ---------------------------------------------------------------------------
// joinToolPath
// ---------------------------------------------------------------------------

describe("joinToolPath", () => {
  it.effect("joins namespace and toolId", () =>
    Effect.sync(() => {
      expect(joinToolPath("github", "search")).toBe("github.search");
    }),
  );

  it.effect("returns toolId when namespace is undefined", () =>
    Effect.sync(() => {
      expect(joinToolPath(undefined, "search")).toBe("search");
    }),
  );
});

// ---------------------------------------------------------------------------
// Plugin lifecycle
// ---------------------------------------------------------------------------

describe("mcpPlugin", () => {
  it.effect("creates executor with mcp plugin", () =>
    Effect.gen(function* () {
      const executor = yield* createExecutor(
        makeTestConfig({
          plugins: [mcpPlugin()] as const,
        }),
      );

      expect(executor.mcp).toBeDefined();
      expect(executor.mcp.addServer).toBeTypeOf("function");
      expect(executor.mcp.removeServer).toBeTypeOf("function");
      expect(executor.mcp.getServer).toBeTypeOf("function");
      expect(executor.mcp.probeEndpoint).toBeTypeOf("function");
      expect(executor.oauth.start).toBeTypeOf("function");
      expect(executor.oauth.complete).toBeTypeOf("function");
    }),
  );

  it.effect("routes remote connector traffic through the provided HttpClient layer", () =>
    Effect.gen(function* () {
      const seen: string[] = [];
      const httpClientLayer = Layer.succeed(HttpClient.HttpClient)(
        HttpClient.make((request: HttpClientRequest.HttpClientRequest) => {
          seen.push(request.url);
          return Effect.succeed(
            HttpClientResponse.fromWeb(request, new Response("blocked", { status: 403 })),
          );
        }),
      );

      const error = yield* createMcpConnector({
        transport: "remote",
        endpoint: "https://internal.example/mcp",
        remoteTransport: "streamable-http",
        httpClientLayer,
      }).pipe(Effect.flip);

      expect(Predicate.isTagged(error, "McpConnectionError")).toBe(true);
      expect(seen).toEqual(["https://internal.example/mcp"]);
    }),
  );

  it.effect("integration catalog has no configured MCP integrations initially", () =>
    Effect.gen(function* () {
      const executor = yield* createExecutor(makeTestConfig({ plugins: [mcpPlugin()] as const }));
      const integrations = yield* executor.integrations.list();
      expect(integrations.filter((i) => i.kind === "mcp")).toHaveLength(0);
    }),
  );

  it.effect("connection tools list is empty until a connection is created", () =>
    Effect.gen(function* () {
      const executor = yield* createExecutor(makeTestConfig({ plugins: [mcpPlugin()] as const }));
      const tools = yield* executor.tools.list();
      expect(tools.filter((tool) => String(tool.address).startsWith("tools."))).toHaveLength(0);
    }),
  );

  it.effect("removing an MCP server removes the OAuth client used by its connection", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const server = yield* serveOAuthTestServer({ scopes: [] });
        const executor = yield* createExecutor(
          makeTestConfig({ plugins: [memoryCredentialsPlugin(), mcpPlugin()] as const }),
        );
        const attachedClient = OAuthClientSlug.make("axiom-mcp");
        const unrelatedClient = OAuthClientSlug.make("manual-app");

        yield* executor.mcp.addServer({
          name: "Axiom MCP",
          endpoint: "http://127.0.0.1:1/mcp",
          slug: "axiom_mcp",
          auth: { kind: "oauth2" },
        });
        yield* executor.oauth.createClient({
          owner: "org",
          slug: attachedClient,
          authorizationUrl: server.authorizationEndpoint,
          tokenUrl: server.tokenEndpoint,
          grant: "client_credentials",
          clientId: "test-client",
          clientSecret: "test-secret",
          resource: server.mcpResourceUrl,
          origin: {
            kind: "dynamic_client_registration",
            integration: IntegrationSlug.make("axiom_mcp"),
          },
        });
        yield* executor.oauth.createClient({
          owner: "org",
          slug: unrelatedClient,
          authorizationUrl: server.authorizationEndpoint,
          tokenUrl: server.tokenEndpoint,
          grant: "client_credentials",
          clientId: "test-client",
          clientSecret: "test-secret",
          resource: server.mcpResourceUrl,
        });

        const connected = yield* executor.oauth.start({
          owner: "org",
          client: attachedClient,
          clientOwner: "org",
          name: ConnectionName.make("main"),
          integration: IntegrationSlug.make("axiom_mcp"),
          template: AuthTemplateSlug.make("oauth2"),
        });
        expect(connected.status).toBe("connected");

        yield* executor.mcp.removeServer("axiom_mcp");

        const clients = yield* executor.oauth.listClients();
        expect(clients.map((client) => String(client.slug))).not.toContain("axiom-mcp");
        expect(clients.map((client) => String(client.slug))).toContain("manual-app");
      }),
    ),
  );

  it.effect("removing an MCP server removes a legacy orphaned DCR-looking OAuth client", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const executor = yield* createExecutor(
          makeTestConfig({ plugins: [memoryCredentialsPlugin(), mcpPlugin()] as const }),
        );

        yield* executor.mcp.addServer({
          name: "Axiom MCP",
          endpoint: "https://mcp.axiom.co/mcp",
          slug: "axiom_mcp",
          auth: { kind: "oauth2" },
        });
        yield* executor.oauth.createClient({
          owner: "org",
          slug: OAuthClientSlug.make("axiom-mcp"),
          authorizationUrl: "https://mcp.axiom.co/authorize",
          tokenUrl: "https://mcp.axiom.co/token",
          grant: "authorization_code",
          clientId: "stale-dcr-client",
          clientSecret: "",
          resource: "https://mcp.axiom.co/mcp",
        });
        yield* executor.oauth.createClient({
          owner: "org",
          slug: OAuthClientSlug.make("manual-app"),
          authorizationUrl: "https://mcp.axiom.co/authorize",
          tokenUrl: "https://mcp.axiom.co/token",
          grant: "authorization_code",
          clientId: "manual-client",
          clientSecret: "",
          resource: "https://mcp.axiom.co/mcp",
        });

        yield* executor.mcp.removeServer("axiom_mcp");

        const clients = yield* executor.oauth.listClients();
        expect(clients.map((client) => String(client.slug))).not.toContain("axiom-mcp");
        expect(clients.map((client) => String(client.slug))).toContain("manual-app");
      }),
    ),
  );

  // Custom-method create (configureAuth) merge-appends onto the declared set —
  // adding an API key to an OAuth server must NOT displace the OAuth method.
  it.effect("configureAuth merge-appends a custom method without clobbering oauth", () =>
    Effect.gen(function* () {
      const executor = yield* createExecutor(makeTestConfig({ plugins: [mcpPlugin()] as const }));

      yield* executor.mcp.addServer({
        name: "OAuth MCP",
        endpoint: "https://mcp.example.com/mcp",
        slug: "oauth_mcp",
        auth: { kind: "oauth2" },
      });

      const merged = yield* executor.mcp.configureAuth("oauth_mcp", {
        authenticationTemplate: [
          { type: "apiKey", headers: { "X-Api-Key": [{ type: "variable", name: "token" }] } },
        ],
      });

      expect(merged.map((method) => method.kind)).toEqual(["oauth2", "apikey"]);
      expect(merged[0]?.slug).toBe("oauth2");
      expect(merged[1]?.slug).toMatch(/^custom_/);

      // The catalog projects both methods.
      const integration = yield* executor.integrations.get(IntegrationSlug.make("oauth_mcp"));
      expect(integration?.authMethods.map((method) => method.kind)).toEqual(["oauth", "apikey"]);
    }),
  );

  it.effect("configureAuth replace mode swaps the declared set with kind-based slugs", () =>
    Effect.gen(function* () {
      const executor = yield* createExecutor(makeTestConfig({ plugins: [mcpPlugin()] as const }));

      yield* executor.mcp.addServer({
        name: "Open MCP",
        endpoint: "https://mcp.example.com/mcp",
        slug: "open_mcp",
      });

      const merged = yield* executor.mcp.configureAuth("open_mcp", {
        authenticationTemplate: [
          { kind: "oauth2" },
          {
            type: "apiKey",
            headers: { Authorization: ["Bearer ", { type: "variable", name: "token" }] },
          },
        ],
        mode: "replace",
      });

      expect(merged.map((method) => method.slug)).toEqual(["oauth2", "header"]);
    }),
  );

  it.effect("oauth.start discovers scopes for an MCP oauth method", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const server = yield* serveOAuthTestServer({
          scopes: ["channels:history", "users:read"],
        });
        const executor = yield* createExecutor(
          makeTestConfig({ plugins: [memoryCredentialsPlugin(), mcpPlugin()] as const }),
        );

        yield* executor.mcp.addServer({
          name: "Slack MCP",
          endpoint: server.mcpResourceUrl,
          slug: "slack_mcp",
          authenticationTemplate: [{ kind: "oauth2" }],
        });
        yield* executor.oauth.createClient({
          owner: "org",
          slug: OAuthClientSlug.make("slack-app"),
          authorizationUrl: server.authorizationEndpoint,
          tokenUrl: server.tokenEndpoint,
          grant: "authorization_code",
          clientId: "test-client",
          clientSecret: "test-secret",
          resource: server.mcpResourceUrl,
        });

        const started = yield* executor.oauth.start({
          owner: "org",
          client: OAuthClientSlug.make("slack-app"),
          clientOwner: "org",
          name: ConnectionName.make("main"),
          integration: IntegrationSlug.make("slack_mcp"),
          template: AuthTemplateSlug.make("oauth2"),
        });

        expect(started.status).toBe("redirect");
        if (started.status !== "redirect") return;
        expect(scopesFromAuthorizeUrl(started.authorizationUrl)).toEqual([
          "channels:history",
          "users:read",
        ]);
      }),
    ),
  );

  // When discovery fails (auth, network, etc.) the connection still lands with
  // an empty tool set so the user can retry via `connections.refresh` once they
  // fix the underlying problem.
  it.effect("registers integration + connection with 0 tools when discovery fails", () =>
    Effect.gen(function* () {
      const executor = yield* createExecutor(
        makeTestConfig({ plugins: [memoryCredentialsPlugin(), mcpPlugin()] as const }),
      );

      const slugStr = "broken_source";
      yield* executor.mcp.addServer({
        name: "broken",
        // Port 1 is reserved — connection-refused immediately, giving a
        // deterministic discovery failure without any server mocks.
        endpoint: "http://127.0.0.1:1/mcp",
        slug: slugStr,
      });
      const connection = yield* executor.connections.create({
        owner: "org",
        name: ConnectionName.make("main"),
        integration: IntegrationSlug.make(slugStr),
        template: TEMPLATE,
        value: "",
      });
      expect(String(connection.address)).toBe("tools.broken_source.org.main");

      const integration = yield* executor.integrations.get(IntegrationSlug.make(slugStr));
      expect(integration?.kind).toBe("mcp");

      const tools = yield* executor.tools.list();
      expect(tools.filter((t) => String(t.integration) === slugStr)).toHaveLength(0);
    }),
  );

  it.effect("static probeEndpoint returns actionable tool failures", () =>
    Effect.gen(function* () {
      const config = makeTestConfig({ plugins: [mcpPlugin()] as const });
      const executor = yield* createExecutor(config);

      const result = yield* executor.execute(ToolAddress.make("executor.mcp.probeEndpoint"), {
        endpoint: "http://127.0.0.1:1/mcp",
      });

      expect(result).toMatchObject({
        ok: false,
        error: {
          code: "mcp_connection_failed",
        },
      });

      yield* executor.close();
      yield* Effect.promise(() => config.testDb.close());
    }),
  );

  for (const status of [401, 403] as const) {
    it.effect(`returns an auth tool failure when tools/call responds HTTP ${status}`, () =>
      Effect.scoped(
        Effect.gen(function* () {
          const slug = `call_status_${status}`;
          const { executor, toolAddress } = yield* seedCallToolExecutor({
            slug,
            callTool: httpStatusCallTool(status),
          });

          const result = yield* executor.execute(toolAddress, {}, { onElicitation: "accept-all" });

          expect(result).toMatchObject({
            ok: false,
            error: {
              code: "connection_rejected",
              status,
              retryable: false,
              details: {
                category: "authentication",
                source: { id: slug },
                credential: { kind: "upstream", label: "main" },
                upstream: { status },
              },
            },
          });

          const failure = result as {
            readonly ok: false;
            readonly error: { readonly message: string };
          };
          expect(failure.error).toMatchObject({
            message: expect.not.stringContaining("do-not-leak"),
          });
        }),
      ),
    );
  }

  it.effect("does not classify non-auth tools/call HTTP failures as auth failures", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { executor, toolAddress } = yield* seedCallToolExecutor({
          slug: "call_status_500",
          callTool: httpStatusCallTool(500),
        });

        const failure = yield* executor
          .execute(toolAddress, {}, { onElicitation: "accept-all" })
          .pipe(Effect.flip);
        expect(Predicate.isTagged(failure, "ToolInvocationError")).toBe(true);

        const error = failure as { readonly message: string; readonly cause?: unknown };
        expect(error).toMatchObject({ message: "MCP tool call failed for explode" });
        expect(error).toMatchObject({ message: expect.not.stringContaining("do-not-leak") });
        expect(Predicate.isTagged(error.cause, "McpInvocationError")).toBe(true);
        const cause = error.cause as McpInvocationError;
        expect(cause.status).toBe(500);
        expect(cause).toMatchObject({ message: expect.not.stringContaining("do-not-leak") });
        expect("cause" in cause).toBe(false);
      }),
    ),
  );

  it.effect("does not classify JSON-RPC error codes as auth failures", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { executor, toolAddress } = yield* seedCallToolExecutor({
          slug: "call_jsonrpc_401",
          callTool: jsonRpcErrorCallTool(401),
        });

        const failure = yield* executor
          .execute(toolAddress, {}, { onElicitation: "accept-all" })
          .pipe(Effect.flip);
        expect(Predicate.isTagged(failure, "ToolInvocationError")).toBe(true);

        const error = failure as { readonly message: string; readonly cause?: unknown };
        expect(error).toMatchObject({ message: "MCP tool call failed for explode" });
        expect(error).toMatchObject({ message: expect.not.stringContaining("do-not-leak") });
        expect(Predicate.isTagged(error.cause, "McpInvocationError")).toBe(true);
        const cause = error.cause as McpInvocationError;
        expect(cause.status).toBeUndefined();
      }),
    ),
  );

  it.effect("probeEndpoint returns manual auth when MCP requires auth without OAuth metadata", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const server = yield* serveTestHttpApp((request) =>
          Effect.succeed(
            (request.url ?? "").includes("/.well-known/")
              ? HttpServerResponse.text("missing", { status: 404 })
              : HttpServerResponse.jsonUnsafe(
                  {
                    jsonrpc: "2.0",
                    id: null,
                    error: { code: -32000, message: "Unauthorized: Valid API key required." },
                  },
                  { status: 401, headers: { "www-authenticate": "Bearer" } },
                ),
          ),
        );
        const config = makeTestConfig({ plugins: [mcpPlugin()] as const });
        const executor = yield* createExecutor(config);

        const result = yield* executor.mcp.probeEndpoint(server.url("/mcp"));

        expect(result).toMatchObject({
          connected: false,
          requiresAuthentication: true,
          requiresOAuth: false,
          supportsDynamicRegistration: false,
          toolCount: null,
        });

        yield* executor.close();
        yield* Effect.promise(() => config.testDb.close());
      }),
    ),
  );

  it.effect(
    "probeEndpoint treats a non-spec-compliant 401 as requires-auth instead of dead-ending",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          // Auth-gated shape: a 401 with no Bearer WWW-Authenticate, no
          // RFC 9728 protected-resource metadata, and a non-JSON-RPC body.
          // probeMcpEndpointShape classifies this `not-mcp`/auth-required, but
          // the user should still get the auth editor (not a dead-end error)
          // so they can declare a method and connect an account afterward.
          const server = yield* serveTestHttpApp((request) =>
            Effect.succeed(
              (request.url ?? "").includes("/.well-known/")
                ? HttpServerResponse.text("missing", { status: 404 })
                : HttpServerResponse.jsonUnsafe({ message: "Unauthorized" }, { status: 401 }),
            ),
          );
          const config = makeTestConfig({ plugins: [mcpPlugin()] as const });
          const executor = yield* createExecutor(config);

          const result = yield* executor.mcp.probeEndpoint(server.url("/mcp"));

          expect(result).toMatchObject({
            connected: false,
            requiresAuthentication: true,
            requiresOAuth: false,
            toolCount: null,
          });

          yield* executor.close();
          yield* Effect.promise(() => config.testDb.close());
        }),
      ),
  );

  it.effect("probeEndpoint keeps auth-gated non-MCP OAuth services on manual auth", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const server = yield* serveTestHttpApp((request) =>
          Effect.sync(() => {
            const origin = `http://${request.headers.host ?? "127.0.0.1"}`;
            const requestUrl = new URL(request.url, origin);

            if (
              requestUrl.pathname === "/.well-known/oauth-authorization-server" ||
              requestUrl.pathname === "/.well-known/openid-configuration"
            ) {
              return HttpServerResponse.jsonUnsafe({
                issuer: origin,
                authorization_endpoint: `${origin}/authorize`,
                token_endpoint: `${origin}/token`,
                response_types_supported: ["code"],
                grant_types_supported: ["authorization_code"],
              });
            }

            return HttpServerResponse.jsonUnsafe({ message: "Unauthorized" }, { status: 401 });
          }),
        );
        const config = makeTestConfig({ plugins: [mcpPlugin()] as const });
        const executor = yield* createExecutor(config);

        const result = yield* executor.mcp.probeEndpoint(server.url("/mcp"));

        expect(result).toMatchObject({
          connected: false,
          requiresAuthentication: true,
          requiresOAuth: false,
          supportsDynamicRegistration: false,
          toolCount: null,
        });

        yield* executor.close();
        yield* Effect.promise(() => config.testDb.close());
      }),
    ),
  );
});

// ---------------------------------------------------------------------------
// destructiveHint → requiresApproval (end-to-end with a real local server)
// ---------------------------------------------------------------------------

const serveAnnotationsTestServer = serveMcpServer(makeAnnotationsMcpServer);

const seedAnnotationsExecutor = (serverUrl: string) =>
  createExecutor(
    makeTestConfig({ plugins: [memoryCredentialsPlugin(), mcpPlugin()] as const }),
  ).pipe(
    Effect.tap((executor) =>
      Effect.gen(function* () {
        yield* executor.mcp.addServer({
          name: "annotations-test",
          endpoint: serverUrl,
          slug: "annotations_test",
        });
        yield* executor.connections.create({
          owner: "org",
          name: ConnectionName.make("main"),
          integration: IntegrationSlug.make("annotations_test"),
          template: TEMPLATE,
          value: "",
        });
      }),
    ),
  );

describe("MCP destructiveHint → requiresApproval", () => {
  it.effect("destructiveHint becomes requiresApproval, others stay false", () =>
    Effect.gen(function* () {
      const server = yield* serveAnnotationsTestServer;
      const executor = yield* seedAnnotationsExecutor(server.url);

      const tools = yield* executor.tools.list();

      const deleteTool = tools.find((t) => String(t.name) === "delete");
      expect(deleteTool?.annotations?.requiresApproval).toBe(true);

      const listTool = tools.find((t) => String(t.name) === "list");
      expect(listTool?.annotations?.requiresApproval).toBeFalsy();

      const pingTool = tools.find((t) => String(t.name) === "ping");
      expect(pingTool?.annotations?.requiresApproval).toBeFalsy();
    }),
  );

  it.effect("uses annotations.title as approvalDescription when present", () =>
    Effect.gen(function* () {
      const server = yield* serveAnnotationsTestServer;
      const executor = yield* seedAnnotationsExecutor(server.url);

      const tools = yield* executor.tools.list();
      const deleteTitled = tools.find((t) => String(t.name) === "delete_titled");
      expect(deleteTitled?.annotations?.requiresApproval).toBe(true);
      expect(deleteTitled?.annotations?.approvalDescription).toBe("Delete dataset");
    }),
  );
});

describe("userFacingProbeMessage", () => {
  it("turns wrong-shape into a 'not an MCP server' message", () => {
    const message = userFacingProbeMessage({
      kind: "not-mcp",
      category: "wrong-shape",
      reason: "2xx POST body is not a JSON-RPC envelope",
    });
    expect(message).toMatch(/doesn't appear to host an MCP server/i);
  });

  it("turns unreachable into a connectivity message", () => {
    const message = userFacingProbeMessage({
      kind: "unreachable",
      reason: "ECONNREFUSED",
    });
    expect(message).toMatch(/couldn't reach/i);
  });

  it("never surfaces the raw probe reason verbatim", () => {
    const reason = "2xx POST body is not a JSON-RPC envelope";
    const message = userFacingProbeMessage({ kind: "not-mcp", category: "wrong-shape", reason });
    expect(message).not.toContain(reason);
  });
});

describe("mcpPlugin detect URL-token fallback", () => {
  // Port 1 connection-refuses immediately, so wire-shape detection returns
  // `unreachable` and the URL-token fallback is the only thing that can produce
  // a candidate.
  it.effect("returns low-confidence candidate when path has /mcp segment", () =>
    Effect.gen(function* () {
      const executor = yield* createExecutor(makeTestConfig({ plugins: [mcpPlugin()] as const }));
      const results = yield* executor.integrations.detect("http://127.0.0.1:1/api/mcp");
      const mcp = results.find((r) => r.kind === "mcp");
      expect(mcp).toBeDefined();
      expect(mcp?.confidence).toBe("low");
    }),
  );

  it.effect("matches mcp on hostname label", () =>
    Effect.gen(function* () {
      const executor = yield* createExecutor(makeTestConfig({ plugins: [mcpPlugin()] as const }));
      const results = yield* executor.integrations.detect("http://mcp.127.0.0.1.nip.io:1/");
      const mcp = results.find((r) => r.kind === "mcp");
      expect(mcp?.confidence).toBe("low");
    }),
  );

  it.effect("does not match mcp as a substring", () =>
    Effect.gen(function* () {
      const executor = yield* createExecutor(makeTestConfig({ plugins: [mcpPlugin()] as const }));
      // `/mcpstore` contains `mcp` but it is not a separator-bounded run, so
      // the URL-token fallback must not fire.
      const results = yield* executor.integrations.detect("http://127.0.0.1:1/mcpstore");
      expect(results.find((r) => r.kind === "mcp")).toBeUndefined();
    }),
  );

  it.effect("returns null when no token match and no wire-shape match", () =>
    Effect.gen(function* () {
      const executor = yield* createExecutor(makeTestConfig({ plugins: [mcpPlugin()] as const }));
      const results = yield* executor.integrations.detect("http://127.0.0.1:1/api/v1");
      expect(results.find((r) => r.kind === "mcp")).toBeUndefined();
    }),
  );
});
