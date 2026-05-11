import { describe, expect, it } from "@effect/vitest";
import { Effect, Result } from "effect";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import {
  ConnectionId,
  CreateConnectionInput,
  SecretId,
  Scope,
  ScopeId,
  TokenMaterial,
  OAUTH2_PROVIDER_KEY,
  createExecutor,
  definePlugin,
  makeTestConfig,
  type SecretProvider,
} from "@executor-js/sdk";

import { mcpPlugin, userFacingProbeMessage } from "./plugin";
import { MCP_OAUTH_CONNECTION_SLOT } from "./types";
import { extractManifestFromListToolsResult, deriveMcpNamespace, joinToolPath } from "./manifest";
import { serveMcpServer } from "../testing";

// ---------------------------------------------------------------------------
// Memory secrets plugin — without a writable provider in the stack,
// `executor.connections.create` has nowhere to persist its owned
// access/refresh-token secret rows, so the per-user sign-in test below
// can't mint a connection.
// ---------------------------------------------------------------------------

const makeMemorySecretsPlugin = () => {
  const store = new Map<string, string>();
  const provider: SecretProvider = {
    key: "memory",
    writable: true,
    get: (id, scope) => Effect.sync(() => store.get(`${scope}${id}`) ?? null),
    set: (id, value, scope) =>
      Effect.sync(() => {
        store.set(`${scope}${id}`, value);
      }),
    delete: (id, scope) => Effect.sync(() => store.delete(`${scope}${id}`)),
    list: () =>
      Effect.sync(() =>
        Array.from(store.keys()).map((k) => {
          const name = k.split("", 2)[1] ?? k;
          return { id: name, name };
        }),
      ),
  };
  return definePlugin(() => ({
    id: "memory-secrets" as const,
    storage: () => ({}),
    secretProviders: [provider],
  }));
};

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
      expect(executor.mcp.addSource).toBeTypeOf("function");
      expect(executor.mcp.removeSource).toBeTypeOf("function");
      expect(executor.mcp.refreshSource).toBeTypeOf("function");
      expect(executor.mcp.probeEndpoint).toBeTypeOf("function");
      expect(executor.oauth.start).toBeTypeOf("function");
      expect(executor.oauth.complete).toBeTypeOf("function");
    }),
  );

  it.effect("sources list is initially empty", () =>
    Effect.gen(function* () {
      const executor = yield* createExecutor(makeTestConfig({ plugins: [mcpPlugin()] as const }));
      const sources = yield* executor.sources.list();
      expect(sources).toHaveLength(0);
    }),
  );

  it.effect("tools list is initially empty", () =>
    Effect.gen(function* () {
      const executor = yield* createExecutor(makeTestConfig({ plugins: [mcpPlugin()] as const }));
      const tools = yield* executor.tools.list();
      expect(tools).toHaveLength(0);
    }),
  );

  // When discovery fails (auth, network, etc.) we still want the source
  // row to land in the DB so users see it in the catalog — they can
  // retry via refresh once they fix the underlying problem. The error
  // still propagates to the caller so boot-time sync logs the reason.
  it.effect("registers source with 0 tools when discovery fails", () =>
    Effect.gen(function* () {
      const executor = yield* createExecutor(makeTestConfig({ plugins: [mcpPlugin()] as const }));

      const result = yield* executor.mcp
        .addSource({
          transport: "remote",
          scope: "test-scope",
          name: "broken",
          // Port 1 is reserved — will connection-refused immediately,
          // giving us a deterministic discovery failure without any
          // server mocks.
          endpoint: "http://127.0.0.1:1/mcp",
          remoteTransport: "auto",
          namespace: "broken_source",
        })
        .pipe(Effect.result);

      expect(Result.isFailure(result)).toBe(true);

      const sources = yield* executor.sources.list();
      const broken = sources.find((s) => s.id === "broken_source");
      expect(broken).toBeDefined();
      expect(broken?.kind).toBe("mcp");
      expect(broken?.pluginId).toBe("mcp");

      const tools = yield* executor.tools.list();
      expect(tools.filter((t) => t.sourceId === "broken_source")).toHaveLength(0);
    }),
  );

  // -------------------------------------------------------------------------
  // Multi-scope shadowing — regression suite covering the bug class where
  // store reads/writes that don't pin scope_id collapse onto whichever row
  // the scoped adapter's `scope_id IN (stack)` filter sees first. Each
  // scenario is reproducible against the pre-fix store.
  //
  // MCP discovery runs on addSource against an unreachable endpoint so
  // both addSource calls fail discovery but still persist the source row
  // (the behavior the "registers source with 0 tools" test above relies
  // on). This gives us two rows at the same namespace across two scopes
  // without needing an in-test MCP server.
  // -------------------------------------------------------------------------

  const ORG_SCOPE = ScopeId.make("org-scope");
  const USER_SCOPE = ScopeId.make("user-scope");

  const stackedScopes = [
    new Scope({ id: USER_SCOPE, name: "user", createdAt: new Date() }),
    new Scope({ id: ORG_SCOPE, name: "org", createdAt: new Date() }),
  ] as const;

  // `seedShadowed` wraps `executor.mcp.addSource` at a given scope with
  // a broken endpoint. Discovery fails (port 1 is reserved) so the call
  // returns Failure, but the source row still lands — exactly the
  // "registers source with 0 tools when discovery fails" behavior above.
  // We use `Effect.result` so the outer `yield*` never fails the test.
  const seedShadowed = (
    addSource: (c: {
      readonly transport: "remote";
      readonly scope: string;
      readonly name: string;
      readonly endpoint: string;
      readonly remoteTransport: "auto";
      readonly namespace: string;
    }) => Effect.Effect<unknown, unknown>,
    args: {
      readonly scope: string;
      readonly name: string;
      readonly endpoint: string;
    },
  ) =>
    addSource({
      transport: "remote",
      scope: args.scope,
      name: args.name,
      endpoint: args.endpoint,
      remoteTransport: "auto",
      namespace: "shared",
    }).pipe(Effect.result);

  it.effect("shadowed addSource does not wipe the outer-scope source", () =>
    Effect.gen(function* () {
      const executor = yield* createExecutor(
        makeTestConfig({
          scopes: stackedScopes,
          plugins: [mcpPlugin()] as const,
        }),
      );

      // Org-level base source — discovery fails but row persists.
      yield* seedShadowed(executor.mcp.addSource, {
        scope: ORG_SCOPE,
        name: "Org Source",
        endpoint: "http://127.0.0.1:1/org-mcp",
      });

      // Per-user shadow with the same namespace.
      yield* seedShadowed(executor.mcp.addSource, {
        scope: USER_SCOPE,
        name: "User Source",
        endpoint: "http://127.0.0.1:1/user-mcp",
      });

      const userView = yield* executor.mcp.getSource("shared", USER_SCOPE);
      const orgView = yield* executor.mcp.getSource("shared", ORG_SCOPE);

      // Both rows must coexist — the store's scope-pinned getters
      // return the exact row regardless of the scope stack's
      // fall-through order.
      expect(userView?.name).toBe("User Source");
      expect(userView?.scope).toBe(USER_SCOPE);
      expect(orgView?.name).toBe("Org Source");
      expect(orgView?.scope).toBe(ORG_SCOPE);
    }),
  );

  it.effect("removeSource on user shadow leaves the org row intact", () =>
    Effect.gen(function* () {
      const executor = yield* createExecutor(
        makeTestConfig({
          scopes: stackedScopes,
          plugins: [mcpPlugin()] as const,
        }),
      );

      yield* seedShadowed(executor.mcp.addSource, {
        scope: ORG_SCOPE,
        name: "Org Source",
        endpoint: "http://127.0.0.1:1/org-mcp",
      });
      yield* seedShadowed(executor.mcp.addSource, {
        scope: USER_SCOPE,
        name: "User Source",
        endpoint: "http://127.0.0.1:1/user-mcp",
      });

      yield* executor.mcp.removeSource("shared", USER_SCOPE);

      const userView = yield* executor.mcp.getSource("shared", USER_SCOPE);
      const orgView = yield* executor.mcp.getSource("shared", ORG_SCOPE);

      expect(userView).toBeNull();
      expect(orgView?.name).toBe("Org Source");
    }),
  );

  it.effect("updateSource on user shadow does not mutate the org row", () =>
    Effect.gen(function* () {
      const executor = yield* createExecutor(
        makeTestConfig({
          scopes: stackedScopes,
          plugins: [mcpPlugin()] as const,
        }),
      );

      yield* seedShadowed(executor.mcp.addSource, {
        scope: ORG_SCOPE,
        name: "Org Source",
        endpoint: "http://127.0.0.1:1/org-mcp",
      });
      yield* seedShadowed(executor.mcp.addSource, {
        scope: USER_SCOPE,
        name: "User Source",
        endpoint: "http://127.0.0.1:1/user-mcp",
      });

      yield* executor.mcp.updateSource("shared", USER_SCOPE, {
        name: "User Renamed",
        endpoint: "http://127.0.0.1:1/user-new-mcp",
      });

      const userView = yield* executor.mcp.getSource("shared", USER_SCOPE);
      const orgView = yield* executor.mcp.getSource("shared", ORG_SCOPE);

      expect(userView?.name).toBe("User Renamed");
      expect(userView?.config.transport).toBe("remote");
      if (userView?.config.transport !== "remote") return;
      expect(userView.config.endpoint).toBe("http://127.0.0.1:1/user-new-mcp");
      expect(orgView?.name).toBe("Org Source");
      expect(orgView?.config.transport).toBe("remote");
      if (orgView?.config.transport !== "remote") return;
      expect(orgView.config.endpoint).toBe("http://127.0.0.1:1/org-mcp");
    }),
  );

  it.effect("updateSource removes bindings for credential slots no longer present", () =>
    Effect.gen(function* () {
      const executor = yield* createExecutor(
        makeTestConfig({
          plugins: [makeMemorySecretsPlugin()(), mcpPlugin()] as const,
        }),
      );

      yield* executor.secrets.set({
        id: SecretId.make("old-token"),
        scope: ScopeId.make("test-scope"),
        name: "Old token",
        value: "old-secret",
        provider: "memory",
      });

      yield* executor.mcp
        .addSource({
          transport: "remote",
          scope: "test-scope",
          name: "stale binding",
          endpoint: "http://127.0.0.1:1/mcp",
          namespace: "stale_binding",
          credentialTargetScope: "test-scope",
          auth: {
            kind: "header",
            headerName: "Authorization",
            secretId: "old-token",
            prefix: "Bearer ",
          },
        })
        .pipe(Effect.result);

      yield* executor.mcp.updateSource("stale_binding", "test-scope", {
        auth: { kind: "none" },
      });

      const bindings = yield* executor.mcp.listSourceBindings("stale_binding", "test-scope");
      expect(bindings).toEqual([]);
    }),
  );

  // -------------------------------------------------------------------------
  // Deferred OAuth — admin saves a source with `{kind: "oauth2",
  // connectionId}` before any user has signed in, so the row lands in
  // a "needs sign-in" state. Each user's McpSignInButton later mints a
  // connection at their own scope using the same stable id; innermost-
  // wins shadowing then resolves tokens per-user at invoke time.
  // -------------------------------------------------------------------------

  it.effect("addSource accepts oauth2 auth with no backing connection", () =>
    Effect.gen(function* () {
      const executor = yield* createExecutor(
        makeTestConfig({
          plugins: [makeMemorySecretsPlugin()(), mcpPlugin()] as const,
        }),
      );

      // Save with oauth2 auth but no connection yet. Discovery will
      // fail (port 1 is unreachable and the oauth provider can't
      // resolve a token either) — but the source row still persists,
      // mirroring the existing "registers source with 0 tools when
      // discovery fails" behaviour. This is the "needs sign-in" state.
      const result = yield* executor.mcp
        .addSource({
          transport: "remote",
          scope: "test-scope",
          name: "Deferred OAuth Source",
          endpoint: "http://127.0.0.1:1/deferred-mcp",
          remoteTransport: "auto",
          namespace: "deferred_oauth",
          auth: {
            kind: "oauth2",
            connectionSlot: MCP_OAUTH_CONNECTION_SLOT,
          },
        })
        .pipe(Effect.result);

      // Save itself does not hard-fail the API from the caller's
      // perspective — it returns Failure because discovery failed, but
      // crucially the source row was persisted so the list surfaces
      // it for subsequent sign-in.
      expect(Result.isFailure(result)).toBe(true);

      const stored = yield* executor.mcp.getSource("deferred_oauth", "test-scope");
      expect(stored).not.toBeNull();
      expect(stored?.config.transport).toBe("remote");
      if (stored?.config.transport !== "remote") return;
      expect(stored.config.auth.kind).toBe("oauth2");
      if (stored.config.auth.kind !== "oauth2") return;
      expect(stored.config.auth.connectionSlot).toBe(MCP_OAUTH_CONNECTION_SLOT);

      // Source is visible in the shell list too.
      const sources = yield* executor.sources.list();
      const needsAuth = sources.find((s) => s.id === "deferred_oauth");
      expect(needsAuth).toBeDefined();
      expect(needsAuth?.kind).toBe("mcp");
    }),
  );

  it.effect("source renders in needs-auth state when no connection exists", () =>
    Effect.gen(function* () {
      const executor = yield* createExecutor(
        makeTestConfig({
          plugins: [makeMemorySecretsPlugin()(), mcpPlugin()] as const,
        }),
      );

      yield* executor.mcp
        .addSource({
          transport: "remote",
          scope: "test-scope",
          name: "Needs Auth",
          endpoint: "http://127.0.0.1:1/needs-auth-mcp",
          remoteTransport: "auto",
          namespace: "needs_auth",
          auth: {
            kind: "oauth2",
            connectionSlot: MCP_OAUTH_CONNECTION_SLOT,
          },
        })
        .pipe(Effect.result);

      // The McpSignInButton decides "Sign in" vs "Reconnect" by
      // checking whether the source's oauth2 connectionId matches an
      // existing connection for the user. At this point no
      // connection was ever minted, so the check should be false —
      // i.e. the button would render "Sign in".
      const connections = yield* executor.connections.list();
      const connectionMatch = connections.find((c) => c.id === "mcp-oauth2-needs_auth");
      expect(connectionMatch).toBeUndefined();

      const stored = yield* executor.mcp.getSource("needs_auth", "test-scope");
      expect(stored?.config.transport).toBe("remote");
      if (stored?.config.transport !== "remote") return;
      expect(stored.config.auth.kind).toBe("oauth2");
    }),
  );

  it.effect("signing in as a user transitions the source to connected", () =>
    Effect.gen(function* () {
      const USER_SCOPE_ID = ScopeId.make("user-scope");
      const ORG_SCOPE_ID = ScopeId.make("org-scope");
      const scopes = [
        new Scope({
          id: USER_SCOPE_ID,
          name: "user",
          createdAt: new Date(),
        }),
        new Scope({
          id: ORG_SCOPE_ID,
          name: "org",
          createdAt: new Date(),
        }),
      ] as const;
      const executor = yield* createExecutor(
        makeTestConfig({
          scopes,
          plugins: [makeMemorySecretsPlugin()(), mcpPlugin()] as const,
        }),
      );

      // Admin saves the oauth2 source at the org scope — no tokens
      // yet.
      yield* executor.mcp
        .addSource({
          transport: "remote",
          scope: ORG_SCOPE_ID,
          name: "Team MCP",
          endpoint: "http://127.0.0.1:1/team-mcp",
          remoteTransport: "auto",
          namespace: "team_mcp",
          auth: {
            kind: "oauth2",
            connectionSlot: MCP_OAUTH_CONNECTION_SLOT,
          },
        })
        .pipe(Effect.result);

      // Before sign-in: no connection exists at all.
      const pre = yield* executor.connections.list();
      expect(pre.find((c) => c.id === "mcp-oauth2-team_mcp")).toBeUndefined();

      // User signs in — the SignInButton flow produces a minted
      // connection against the same stable id, pinned to the user
      // scope. This simulates what `completeOAuth` does internally,
      // including persisting provider state.
      const connectionId = ConnectionId.make("mcp-oauth2-team_mcp");
      yield* executor.connections.create(
        new CreateConnectionInput({
          id: connectionId,
          scope: USER_SCOPE_ID,
          provider: OAUTH2_PROVIDER_KEY,
          identityLabel: "user@example.com",
          accessToken: new TokenMaterial({
            secretId: SecretId.make(`${connectionId}.access_token`),
            name: "MCP Access Token",
            value: "access-token-value",
          }),
          refreshToken: null,
          expiresAt: null,
          oauthScope: null,
          providerState: {
            endpoint: "http://127.0.0.1:1/team-mcp",
            tokenType: "Bearer",
            clientInformation: { client_id: "fake" },
            authorizationServerUrl: null,
            authorizationServerMetadata: null,
            resourceMetadataUrl: null,
            resourceMetadata: null,
          },
        }),
      );
      yield* executor.mcp.setSourceBinding({
        sourceId: "team_mcp",
        sourceScope: ORG_SCOPE_ID,
        scope: USER_SCOPE_ID,
        slot: MCP_OAUTH_CONNECTION_SLOT,
        value: { kind: "connection", connectionId },
      });

      // After sign-in: the connection exists and its access token
      // resolves. Source auth config is unchanged — the
      // connectionId pointer now has a live backing row.
      const post = yield* executor.connections.list();
      const match = post.find((c) => c.id === "mcp-oauth2-team_mcp");
      expect(match).toBeDefined();
      expect(match?.scopeId).toBe(USER_SCOPE_ID);

      const accessToken = yield* executor.connections.accessToken(connectionId);
      expect(accessToken).toBe("access-token-value");

      // Source auth still points at the same connectionId — no
      // migration needed, the UI flipped "Sign in" → "Reconnect" by
      // virtue of the connection existing.
      const stored = yield* executor.mcp.getSource("team_mcp", ORG_SCOPE_ID);
      expect(stored?.config.transport).toBe("remote");
      if (stored?.config.transport !== "remote") return;
      expect(stored.config.auth.kind).toBe("oauth2");
      if (stored.config.auth.kind !== "oauth2") return;
      expect(stored.config.auth.connectionSlot).toBe(MCP_OAUTH_CONNECTION_SLOT);
    }),
  );

  // -------------------------------------------------------------------------
  // Usage tracking — refs land on auth_* columns + child tables and the
  // plugin's `usagesForSecret` / `usagesForConnection` should surface
  // every one. addSource against an unreachable endpoint still persists
  // the source row so the assertion runs without needing a live server.
  // -------------------------------------------------------------------------

  it.effect("usagesForSecret aggregates header-auth + headers child rows", () =>
    Effect.gen(function* () {
      const executor = yield* createExecutor(
        makeTestConfig({ plugins: [makeMemorySecretsPlugin()(), mcpPlugin()] as const }),
      );
      yield* executor.secrets.set({
        id: SecretId.make("shared-key"),
        scope: ScopeId.make("test-scope"),
        name: "Shared Key",
        value: "shared",
        provider: "memory",
      });
      yield* executor.secrets.set({
        id: SecretId.make("other-secret"),
        scope: ScopeId.make("test-scope"),
        name: "Other Secret",
        value: "other",
        provider: "memory",
      });

      yield* executor.mcp
        .addSource({
          transport: "remote",
          scope: "test-scope",
          name: "header-auth",
          endpoint: "http://127.0.0.1:1/mcp",
          namespace: "header_auth_source",
          credentialTargetScope: "test-scope",
          auth: {
            kind: "header",
            headerName: "X-API-Key",
            secretId: "shared-key",
          },
          headers: { "X-Trace": { secretId: "shared-key" } },
          queryParams: { ping: { secretId: "other-secret" } },
        })
        .pipe(Effect.result);

      const usages = yield* executor.secrets.usages(SecretId.make("shared-key"));
      expect(usages.length).toBe(2);
      const slots = usages.map((u) => u.slot).sort();
      expect(slots).toEqual(["auth:header", "header:x-trace"]);
      expect(usages.every((u) => u.pluginId === "mcp")).toBe(true);
      expect(usages.every((u) => u.ownerKind === "credential-binding")).toBe(true);

      const otherUsages = yield* executor.secrets.usages(SecretId.make("other-secret"));
      expect(otherUsages.length).toBe(1);
      expect(otherUsages[0].slot).toBe("query_param:ping");
    }),
  );

  it.effect("usagesForConnection finds oauth2-bound mcp sources", () =>
    Effect.gen(function* () {
      const executor = yield* createExecutor(
        makeTestConfig({ plugins: [makeMemorySecretsPlugin()(), mcpPlugin()] as const }),
      );
      yield* executor.connections.create(
        new CreateConnectionInput({
          id: ConnectionId.make("conn-xyz"),
          scope: ScopeId.make("test-scope"),
          provider: OAUTH2_PROVIDER_KEY,
          identityLabel: "OAuth Source",
          accessToken: new TokenMaterial({
            secretId: SecretId.make("conn-xyz.access_token"),
            name: "MCP Access Token",
            value: "access-token-value",
          }),
          refreshToken: null,
          expiresAt: null,
          oauthScope: null,
          providerState: {
            endpoint: "http://127.0.0.1:1/mcp",
            tokenType: "Bearer",
            clientInformation: { client_id: "fake" },
            authorizationServerUrl: null,
            authorizationServerMetadata: null,
            resourceMetadataUrl: null,
            resourceMetadata: null,
          },
        }),
      );

      yield* executor.mcp
        .addSource({
          transport: "remote",
          scope: "test-scope",
          name: "oauth-source",
          endpoint: "http://127.0.0.1:1/mcp",
          namespace: "oauth_ref",
          credentialTargetScope: "test-scope",
          auth: { kind: "oauth2", connectionId: "conn-xyz" },
        })
        .pipe(Effect.result);

      const usages = yield* executor.connections.usages(ConnectionId.make("conn-xyz"));
      expect(usages.length).toBe(1);
      expect(usages[0]).toMatchObject({
        pluginId: "mcp",
        ownerKind: "credential-binding",
        ownerId: "oauth_ref",
        slot: MCP_OAUTH_CONNECTION_SLOT,
      });
    }),
  );
});

// ---------------------------------------------------------------------------
// destructiveHint → requiresApproval (end-to-end with a real local server)
// ---------------------------------------------------------------------------

const createAnnotationsTestServer = () => {
  const mcpServer = new McpServer(
    { name: "annotations-test-server", version: "1.0.0" },
    { capabilities: {} },
  );

  mcpServer.registerTool(
    "delete",
    {
      description: "A destructive tool",
      inputSchema: { id: z.string() },
      annotations: { destructiveHint: true },
    },
    async () => ({ content: [] }),
  );

  mcpServer.registerTool(
    "delete_titled",
    {
      description: "A destructive tool with a title annotation",
      inputSchema: { id: z.string() },
      annotations: { destructiveHint: true, title: "Delete dataset" },
    },
    async () => ({ content: [] }),
  );

  mcpServer.registerTool(
    "list",
    {
      description: "A read-only tool",
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    async () => ({ content: [] }),
  );

  mcpServer.registerTool(
    "ping",
    { description: "An unannotated tool", inputSchema: {} },
    async () => ({ content: [] }),
  );

  return mcpServer;
};

const serveAnnotationsTestServer = serveMcpServer(createAnnotationsTestServer);

describe("MCP destructiveHint → requiresApproval", () => {
  it.effect("destructiveHint becomes requiresApproval, others stay false", () =>
    Effect.gen(function* () {
      const server = yield* serveAnnotationsTestServer;
      const executor = yield* createExecutor(makeTestConfig({ plugins: [mcpPlugin()] as const }));
      yield* executor.mcp.addSource({
        transport: "remote",
        scope: "test-scope",
        name: "annotations-test",
        endpoint: server.url,
      });

      const tools = yield* executor.tools.list();

      const deleteTool = tools.find((t) => t.name === "delete");
      expect(deleteTool?.annotations?.requiresApproval).toBe(true);

      const listTool = tools.find((t) => t.name === "list");
      expect(listTool?.annotations?.requiresApproval).toBeFalsy();

      const pingTool = tools.find((t) => t.name === "ping");
      expect(pingTool?.annotations?.requiresApproval).toBeFalsy();
    }),
  );

  it.effect("uses annotations.title as approvalDescription when present", () =>
    Effect.gen(function* () {
      const server = yield* serveAnnotationsTestServer;
      const executor = yield* createExecutor(makeTestConfig({ plugins: [mcpPlugin()] as const }));
      yield* executor.mcp.addSource({
        transport: "remote",
        scope: "test-scope",
        name: "annotations-test",
        endpoint: server.url,
      });

      const tools = yield* executor.tools.list();
      const deleteTitled = tools.find((t) => t.name === "delete_titled");
      expect(deleteTitled?.annotations?.requiresApproval).toBe(true);
      expect(deleteTitled?.annotations?.approvalDescription).toBe("Delete dataset");
    }),
  );
});

describe("userFacingProbeMessage", () => {
  it("turns auth-required into a credentials-asking message", () => {
    const message = userFacingProbeMessage({
      kind: "not-mcp",
      category: "auth-required",
      reason: "401 without Bearer WWW-Authenticate — not an MCP auth challenge",
    });
    expect(message).toMatch(/requires authentication/i);
    expect(message).toMatch(/credentials/i);
  });

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
    const reasons = [
      "401 without Bearer WWW-Authenticate — not an MCP auth challenge",
      "2xx POST body is not a JSON-RPC envelope",
      "GET response is not an SSE stream",
      "unexpected status 418 for initialize",
    ] as const;
    for (const reason of reasons) {
      const auth = userFacingProbeMessage({ kind: "not-mcp", category: "auth-required", reason });
      const wrong = userFacingProbeMessage({ kind: "not-mcp", category: "wrong-shape", reason });
      expect(auth).not.toContain(reason);
      expect(wrong).not.toContain(reason);
    }
  });
});

describe("mcpPlugin detect URL-token fallback", () => {
  // Port 1 connection-refuses immediately, so wire-shape detection
  // returns `unreachable` and the URL-token fallback is the only thing
  // that can produce a candidate.
  it.effect("returns low-confidence candidate when path has /mcp segment", () =>
    Effect.gen(function* () {
      const executor = yield* createExecutor(makeTestConfig({ plugins: [mcpPlugin()] as const }));
      const results = yield* executor.sources.detect("http://127.0.0.1:1/api/mcp");
      const mcp = results.find((r) => r.kind === "mcp");
      expect(mcp).toBeDefined();
      expect(mcp?.confidence).toBe("low");
    }),
  );

  it.effect("matches mcp on hostname label", () =>
    Effect.gen(function* () {
      const executor = yield* createExecutor(makeTestConfig({ plugins: [mcpPlugin()] as const }));
      const results = yield* executor.sources.detect("http://mcp.127.0.0.1.nip.io:1/");
      const mcp = results.find((r) => r.kind === "mcp");
      expect(mcp?.confidence).toBe("low");
    }),
  );

  it.effect("does not match mcp as a substring", () =>
    Effect.gen(function* () {
      const executor = yield* createExecutor(makeTestConfig({ plugins: [mcpPlugin()] as const }));
      // `/mcpstore` is a substring containing `mcp` but `mcp` is not a
      // separator-bounded run, so the URL-token fallback must not fire.
      const results = yield* executor.sources.detect("http://127.0.0.1:1/mcpstore");
      expect(results.find((r) => r.kind === "mcp")).toBeUndefined();
    }),
  );

  it.effect("returns null when no token match and no wire-shape match", () =>
    Effect.gen(function* () {
      const executor = yield* createExecutor(makeTestConfig({ plugins: [mcpPlugin()] as const }));
      const results = yield* executor.sources.detect("http://127.0.0.1:1/api/v1");
      expect(results.find((r) => r.kind === "mcp")).toBeUndefined();
    }),
  );
});
