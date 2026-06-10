// ---------------------------------------------------------------------------
// examples/all-plugins
//
// Wires every ported plugin into a single Executor and walks the common v2
// flows: credential providers, integration registration, connection creation
// (a connection IS the credential), per-connection tool production, execution,
// filtered listing, and shutdown.
//
// This is what an app/local or app/cloud bootstrap file looks like under the
// v2 SDK shape — minus the HTTP API layer, runtime lifecycle, and owner/tenant
// persistence that real apps add on top.
//
// Runs against the SDK's ephemeral in-memory FumaDB backend so you can
// `bun run src/main.ts` and watch the whole surface exercise itself. Plugins
// that need external infra (keychain prompts, 1Password unlock, MCP transport,
// WorkOS Vault, Google OAuth) are wired so their credential providers and
// extensions exist, but the flows that hit their backends are skipped by
// default.
// ---------------------------------------------------------------------------

import { Cause, Effect, Result } from "effect";

import {
  AuthTemplateSlug,
  ConnectionName,
  createExecutor,
  IntegrationSlug,
  ProviderItemId,
  ProviderKey,
  Tenant,
  ToolAddress,
  type CredentialProvider,
} from "@executor-js/sdk";

import { fileSecretsPlugin } from "@executor-js/plugin-file-secrets";
import { graphqlPlugin } from "@executor-js/plugin-graphql";
import { keychainPlugin } from "@executor-js/plugin-keychain";
import { mcpPlugin } from "@executor-js/plugin-mcp";
import { onepasswordPlugin } from "@executor-js/plugin-onepassword";
import { openApiPlugin, variable } from "@executor-js/plugin-openapi";
import { workosVaultPlugin } from "@executor-js/plugin-workos-vault";

// ---------------------------------------------------------------------------
// 1. Build the ExecutorConfig.
//
// Three pieces: tenant, plugins, and credential providers. The executor
// auto-registers every `plugin.credentialProviders`; `config.providers` adds
// inline ones (registered first, so they win as the default writable store).
// Compare to v1, where you'd pass pre-built ToolRegistry, SourceRegistry,
// SecretStore, and PolicyEngine service instances plus a scope stack.
// ---------------------------------------------------------------------------

// A connection's value lives in a writable credential provider. This tiny
// in-memory store is enough for a script; the keychain / file-secrets /
// 1Password plugins below contribute durable ones. Providers are Effect-native,
// so `get`/`set` return `Effect`s.
const memory = new Map<string, string>();
const memoryProvider: CredentialProvider = {
  key: ProviderKey.make("memory"),
  writable: true,
  get: (id: ProviderItemId) => Effect.sync(() => memory.get(String(id)) ?? null),
  set: (id: ProviderItemId, value: string) =>
    Effect.sync(() => {
      memory.set(String(id), value);
    }),
};

const plugins = [
  // Credential providers — three of them contributed by three plugins. The
  // executor auto-registers each one at startup via `plugin.credentialProviders`
  // (the v2 successor to v1's `secretProviders`). A connection routes its value
  // through one of these.
  keychainPlugin(),
  fileSecretsPlugin(),
  onepasswordPlugin(),

  // Integration plugins — these declare their own schemas (tables), register
  // integrations via their extension methods (`addSpec` / `addServer` /
  // `addIntegration`), and produce tools per connection.
  graphqlPlugin(),
  mcpPlugin({ dangerouslyAllowStdioMCP: false }),
  openApiPlugin(),

  // workos-vault is a cloud-hosted credential provider. It would contribute a
  // "workos-vault" provider if credentials were available. We skip it here
  // because it needs a real WorkOS API key; uncomment and supply credentials to
  // wire it in.
  //
  // workosVaultPlugin({
  //   credentials: {
  //     apiKey: process.env.WORKOS_API_KEY!,
  //     clientId: process.env.WORKOS_CLIENT_ID!,
  //   },
  // }),
] as const;

// Silence the unused-import warning for workos-vault (kept in scope as
// documentation; uncomment the plugin entry above to use it).
void workosVaultPlugin;

// ---------------------------------------------------------------------------
// 2. A tiny OpenAPI spec we'll use to demonstrate integration + connection
// registration. Four operations, all deterministic.
// ---------------------------------------------------------------------------

const exampleOpenApiSpec = JSON.stringify({
  openapi: "3.0.0",
  info: { title: "Example API", version: "1.0.0" },
  servers: [{ url: "https://example.com/api" }],
  paths: {
    "/items": {
      get: {
        operationId: "items.list",
        tags: ["items"],
        summary: "List items",
        responses: {
          "200": {
            description: "ok",
            content: {
              "application/json": {
                schema: {
                  type: "array",
                  items: { $ref: "#/components/schemas/Item" },
                },
              },
            },
          },
        },
      },
      post: {
        operationId: "items.create",
        tags: ["items"],
        summary: "Create an item",
        requestBody: {
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/Item" },
            },
          },
        },
        responses: { "201": { description: "created" } },
      },
    },
    "/items/{id}": {
      get: {
        operationId: "items.get",
        tags: ["items"],
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
        responses: { "200": { description: "ok" } },
      },
      delete: {
        operationId: "items.delete",
        tags: ["items"],
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
        responses: { "204": { description: "deleted" } },
      },
    },
  },
  components: {
    schemas: {
      Item: {
        type: "object",
        properties: {
          id: { type: "string" },
          name: { type: "string" },
        },
        required: ["id", "name"],
      },
    },
  },
});

// ---------------------------------------------------------------------------
// 3. Main program — builds the executor and walks every surface.
// ---------------------------------------------------------------------------

const program = Effect.gen(function* () {
  console.log("=".repeat(72));
  console.log("Building executor with every ported plugin");
  console.log("=".repeat(72));

  const executor = yield* createExecutor({
    tenant: Tenant.make("example-tenant"),
    plugins,
    providers: [memoryProvider],
    onElicitation: "accept-all" as const,
    // `redirectUri` is intentionally omitted: this example never runs an
    // interactive OAuth flow. A host that serves OAuth must pass
    // `${webBaseUrl}/oauth/callback` here (there is no localhost default).
  });

  // Every plugin's extension is accessible as `executor[pluginId]`.
  // TypeScript knows about each one — hovering over `executor` in your
  // editor shows the full merged surface.
  console.log("\nExecutor built. Plugin extensions:");
  console.log("  executor.keychain        ", typeof executor.keychain);
  console.log("  executor.fileSecrets     ", typeof executor.fileSecrets);
  console.log("  executor.onepassword     ", typeof executor.onepassword);
  console.log("  executor.graphql         ", typeof executor.graphql);
  console.log("  executor.mcp             ", typeof executor.mcp);
  console.log("  executor.openapi         ", typeof executor.openapi);

  // -------------------------------------------------------------------------
  // Credential providers — the inline `memory` store plus whichever plugin
  // providers were reachable (keychain/file/1Password register at startup).
  // A connection routes its value through one of these; there is no separate
  // secret store in v2 (a connection IS the saved credential).
  // -------------------------------------------------------------------------

  console.log("\n" + "-".repeat(72));
  console.log("Credential providers");
  console.log("-".repeat(72));

  const providerKeys = yield* executor.providers.list();
  console.log(
    "Registered providers:",
    providerKeys.map((k) => String(k)),
  );

  // -------------------------------------------------------------------------
  // Integration: OpenAPI — register a tiny spec as an integration. The
  // `authenticationTemplate` declares WHERE a connection's value renders on
  // each request (here an `X-API-Key` header); `variable("token")` is the slot
  // the resolved credential fills.
  // -------------------------------------------------------------------------

  console.log("\n" + "-".repeat(72));
  console.log("Integration: OpenAPI");
  console.log("-".repeat(72));

  const addSpecResult = yield* executor.openapi.addSpec({
    spec: { kind: "blob", value: exampleOpenApiSpec },
    slug: "example-api",
    description: "Example API",
    baseUrl: "https://example.com/api",
    authenticationTemplate: [
      {
        slug: "apiKey",
        type: "apiKey",
        headers: { "X-API-Key": [variable("token")] },
      },
    ],
  });
  console.log("Registered OpenAPI integration:", {
    slug: String(addSpecResult.slug),
    toolCount: addSpecResult.toolCount,
  });

  // A connection is the credential. Creating one with an inline `value` writes
  // it to the default writable provider (`memory`) and produces the
  // integration's per-connection tools, addressed
  // `tools.example-api.org.default.<tool>`.
  const openApiConnection = yield* executor.connections.create({
    owner: "org",
    name: ConnectionName.make("default"),
    integration: IntegrationSlug.make("example-api"),
    template: AuthTemplateSlug.make("apiKey"),
    value: "sk-example-redacted",
  });
  console.log("Created connection:", {
    address: String(openApiConnection.address),
    provider: String(openApiConnection.provider),
  });

  const exampleTools = yield* executor.tools.list({
    integration: IntegrationSlug.make("example-api"),
  });
  console.log(
    "Tools under 'example-api':",
    exampleTools.map((t) => String(t.address)),
  );

  // Annotations are derived at read time via plugin.resolveAnnotations.
  // GET tools are auto-approved, POST/DELETE require approval:
  console.log(
    "Annotations on example-api tools:",
    exampleTools.map((t) => ({
      name: String(t.name),
      requiresApproval: t.annotations?.requiresApproval ?? false,
    })),
  );

  // `tools.schema` walks the read path: reads the tool row, attaches matching
  // $defs (the `Item` schema) for $ref resolution.
  const getItemTool = exampleTools.find((t) => String(t.name).startsWith("items__get"));
  if (getItemTool) {
    const getItemSchema = yield* executor.tools.schema(getItemTool.address);
    console.log(
      "Schema for items.get has $defs?",
      getItemSchema?.inputSchema &&
        typeof getItemSchema.inputSchema === "object" &&
        "$defs" in getItemSchema.inputSchema,
    );
  }

  // -------------------------------------------------------------------------
  // Integration: GraphQL — introspect via a canned JSON doc so we don't need a
  // real server running, then connect (this endpoint needs no credential, so
  // the connection carries an empty value through a "none" template).
  // -------------------------------------------------------------------------

  console.log("\n" + "-".repeat(72));
  console.log("Integration: GraphQL");
  console.log("-".repeat(72));

  const introspectionJson = JSON.stringify({
    data: {
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
                description: "Greet someone",
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
                description: "Change the greeting",
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
    },
  });

  const gqlResult = yield* executor.graphql.addIntegration({
    endpoint: "https://example.com/graphql",
    name: "Example GraphQL",
    introspectionJson,
    slug: "example-graphql",
  });
  console.log("Registered GraphQL integration:", gqlResult);

  yield* executor.connections.create({
    owner: "org",
    name: ConnectionName.make("default"),
    integration: IntegrationSlug.make("example-graphql"),
    template: AuthTemplateSlug.make("none"),
    value: "",
  });

  const graphqlTools = yield* executor.tools.list({
    integration: IntegrationSlug.make("example-graphql"),
  });
  console.log(
    "Tools under 'example-graphql':",
    graphqlTools.map((t) => ({
      address: String(t.address),
      requiresApproval: t.annotations?.requiresApproval ?? false,
    })),
  );

  // -------------------------------------------------------------------------
  // Other plugin extensions — shown but not exercised (they need real external
  // infrastructure). Their extension methods exist and would register real
  // integrations + connections the same way.
  //
  // removed: v1 `executor.secrets.set/get/list` and credential bindings — a
  // connection now IS the credential (see the OpenAPI flow above), and its value
  // lives in a registered provider rather than a free-floating secret store.
  // -------------------------------------------------------------------------

  console.log("\n" + "-".repeat(72));
  console.log("Other plugin extensions (not exercised in this demo)");
  console.log("-".repeat(72));

  console.log("  executor.keychain.isSupported:", executor.keychain.isSupported);
  console.log("  executor.keychain.displayName:", executor.keychain.displayName);
  console.log("  executor.fileSecrets.filePath:   ", executor.fileSecrets.filePath);

  // executor.mcp.addServer({ transport: "remote", name: "...", endpoint: "...", slug: "..." });
  // executor.openapi.addSpec({ spec: { kind: "googleDiscovery", url: "..." }, slug: "..." });
  // executor.onepassword.configure({ auth: { kind: "desktop-app", accountName: "..." }, vaultId: "..." });

  // -------------------------------------------------------------------------
  // Execute a tool over its connection. The executor resolves the connection's
  // credential (from the `memory` provider) and hands it to the owning plugin's
  // invokeTool, which renders it through the auth template onto the request.
  // (The example.com host isn't real, so this surfaces a transport-level
  // failure — the point is the resolve + dispatch path, not a live response.)
  // -------------------------------------------------------------------------

  console.log("\n" + "-".repeat(72));
  console.log("Execute over a connection");
  console.log("-".repeat(72));

  const listItemsTool = exampleTools.find((t) => String(t.name).startsWith("items__list"));
  if (listItemsTool) {
    const outcome = yield* Effect.result(
      executor.execute(ToolAddress.make(String(listItemsTool.address)), {}),
    );
    console.log(
      `execute ${String(listItemsTool.address)}:`,
      Result.isSuccess(outcome) ? "ok" : `failed (${outcome.failure.constructor.name})`,
    );
  }

  // -------------------------------------------------------------------------
  // Whole-catalog tools listing + filtering
  // -------------------------------------------------------------------------

  console.log("\n" + "-".repeat(72));
  console.log("Whole catalog");
  console.log("-".repeat(72));

  const allTools = yield* executor.tools.list();
  console.log(`Total tools: ${allTools.length}`);

  const allIntegrations = yield* executor.integrations.list();
  console.log(
    `Total integrations: ${allIntegrations.length}`,
    allIntegrations.map((i) => String(i.slug)),
  );

  const allConnections = yield* executor.connections.list();
  console.log(
    `Total connections: ${allConnections.length}`,
    allConnections.map((c) => String(c.address)),
  );

  const mutationTools = yield* executor.tools.list({ query: "create" });
  console.log(
    "Tools matching 'create':",
    mutationTools.map((t) => String(t.address)),
  );

  // -------------------------------------------------------------------------
  // Shutdown — close() is called on every plugin that declared a `close` hook
  // (the cache-backed ones like MCP tear down their connection pool).
  // -------------------------------------------------------------------------

  console.log("\n" + "-".repeat(72));
  console.log("Shutdown");
  console.log("-".repeat(72));

  yield* executor.close();
  console.log("Executor closed. Done.");
});

// ---------------------------------------------------------------------------
// 4. Run.
// ---------------------------------------------------------------------------

Effect.runPromise(
  program.pipe(
    Effect.catchCause((cause) =>
      Effect.sync(() => {
        console.error("Example failed:", Cause.squash(cause));
        process.exit(1);
      }),
    ),
  ),
);
