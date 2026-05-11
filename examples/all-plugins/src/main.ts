// ---------------------------------------------------------------------------
// examples/all-plugins
//
// Wires every ported plugin into a single Executor and walks through the
// common flows: secrets, static control tools, dynamic source registration,
// tool invocation, filtered listing, and shutdown.
//
// This is what an app/local or app/cloud bootstrap file looks like under
// the new SDK shape — minus the HTTP API layer, runtime lifecycle, and
// scope persistence that real apps add on top.
//
// Runs against an in-memory adapter + in-memory blob store so you can
// `bun run src/main.ts` and watch the whole surface exercise itself.
// Plugins that need external infra (keychain prompts, 1Password unlock,
// MCP transport, WorkOS Vault, Google OAuth) are wired so their secret
// providers and extensions exist, but the flows that hit their
// backends are gated behind env vars and skipped by default.
// ---------------------------------------------------------------------------

import { Cause, Effect } from "effect";

import {
  SecretId,
  Scope,
  ScopeId,
  SetSecretInput,
  collectSchemas,
  createExecutor,
  makeInMemoryBlobStore,
} from "@executor-js/sdk";
import { makeMemoryAdapter } from "@executor-js/storage-core/testing/memory";

import { fileSecretsPlugin } from "@executor-js/plugin-file-secrets";
import { graphqlPlugin } from "@executor-js/plugin-graphql";
import { keychainPlugin } from "@executor-js/plugin-keychain";
import { mcpPlugin } from "@executor-js/plugin-mcp";
import { onepasswordPlugin } from "@executor-js/plugin-onepassword";
import { openApiPlugin } from "@executor-js/plugin-openapi";
import { workosVaultPlugin } from "@executor-js/plugin-workos-vault";

// ---------------------------------------------------------------------------
// 1. Build the ExecutorConfig.
//
// Three pieces only: scope, storage seam (adapter + blobs), plugins.
// Compare to the old SDK, where you'd pass pre-built ToolRegistry,
// SourceRegistry, SecretStore, and PolicyEngine service instances.
// ---------------------------------------------------------------------------

const scope = new Scope({
  id: ScopeId.make("example-scope"),
  name: "/tmp/example-workspace",
  createdAt: new Date(),
});

const plugins = [
  // Secret providers — three of them contributed by three plugins.
  // The executor auto-registers each one at startup via the new
  // `plugin.secretProviders` field.
  keychainPlugin(),
  fileSecretsPlugin(),
  onepasswordPlugin(),

  // Source plugins — these declare their own schemas (tables) and
  // register tools dynamically when the user adds a spec / connects
  // to a server / runs discovery.
  graphqlPlugin(),
  mcpPlugin({ dangerouslyAllowStdioMCP: false }),
  openApiPlugin(),

  // workos-vault is a cloud-hosted secret provider. It would contribute
  // a "workos-vault" provider if credentials were available. We skip it
  // here because it needs a real WorkOS API key; uncomment and supply
  // credentials to wire it in.
  //
  // workosVaultPlugin({
  //   credentials: {
  //     apiKey: process.env.WORKOS_API_KEY!,
  //     clientId: process.env.WORKOS_CLIENT_ID!,
  //   },
  // }),
] as const;

const config = {
  scopes: [scope],
  adapter: makeMemoryAdapter({ schema: collectSchemas(plugins) }),
  blobs: makeInMemoryBlobStore(),
  plugins,
  onElicitation: "accept-all" as const,
};

// Silence the unused-import warning for workos-vault (kept in scope as
// documentation; uncomment the plugin entry above to use it).
void workosVaultPlugin;

// ---------------------------------------------------------------------------
// 2. A tiny OpenAPI spec we'll use to demonstrate dynamic source
// registration. Five operations, all deterministic.
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

  const executor = yield* createExecutor(config);

  // Every plugin's extension is accessible as `executor[pluginId]`.
  // TypeScript knows about each one — hovering over `executor` in your
  // editor shows the full merged surface.
  console.log("\nExecutor built. Plugin extensions:");
  console.log("  executor.keychain        ", typeof executor.keychain);
  console.log("  executor.fileSecrets     ", typeof executor.fileSecrets);
  console.log("  executor.onepassword     ", typeof executor.onepassword);
  console.log("  executor.graphql         ", typeof executor.graphql);
  console.log("  executor.googleDiscovery ", typeof executor.googleDiscovery);
  console.log("  executor.mcp             ", typeof executor.mcp);
  console.log("  executor.openapi         ", typeof executor.openapi);

  // -------------------------------------------------------------------------
  // Secrets — three providers were contributed by plugins. List them, then
  // store a secret pinned to the `file` provider (file-secrets writes to a
  // local auth.json under $XDG_DATA_HOME).
  // -------------------------------------------------------------------------

  console.log("\n" + "-".repeat(72));
  console.log("Secrets");
  console.log("-".repeat(72));

  const providers = yield* executor.secrets.providers();
  console.log("Registered providers:", providers);

  yield* executor.secrets.set(
    new SetSecretInput({
      id: SecretId.make("example-api-token"),
      scope: "example-scope" as SetSecretInput["scope"],
      name: "Example API Token",
      value: "sk-example-redacted",
      provider: "file",
    }),
  );

  const token = yield* executor.secrets.get("example-api-token");
  console.log("Stored + read 'example-api-token':", token);

  const secretRefs = yield* executor.secrets.list();
  console.log(
    "Secret refs:",
    secretRefs.map((r) => `${r.id}@${r.provider}`),
  );

  // -------------------------------------------------------------------------
  // Static control tools — every source plugin exposes its built-in
  // control tools via `staticSources`. They live in memory, not in the
  // DB, and show up in `tools.list()` alongside dynamic ones.
  // -------------------------------------------------------------------------

  console.log("\n" + "-".repeat(72));
  console.log("Static sources / control tools");
  console.log("-".repeat(72));

  const sourcesBefore = yield* executor.sources.list();
  const staticSources = sourcesBefore.filter((s) => s.runtime);
  console.log(
    `Runtime sources (${staticSources.length}):`,
    staticSources.map((s) => s.id),
  );

  const toolsBefore = yield* executor.tools.list();
  const staticTools = toolsBefore.filter((t) => t.sourceId.endsWith(".control"));
  console.log(
    `Static control tools (${staticTools.length}):`,
    staticTools.map((t) => t.id),
  );

  // -------------------------------------------------------------------------
  // Dynamic source: OpenAPI — register a tiny spec. Four tools land in
  // the `tool` table under a `example-api` source, plus one `$defs` entry
  // (the `Item` schema) lands in the `definition` table for $ref
  // resolution at read time.
  // -------------------------------------------------------------------------

  console.log("\n" + "-".repeat(72));
  console.log("Dynamic source: OpenAPI");
  console.log("-".repeat(72));

  const addSpecResult = yield* executor.openapi.addSpec({
    spec: exampleOpenApiSpec,
    namespace: "example-api",
    baseUrl: "https://example.com/api",
    scope: "example-scope",
  });
  console.log("Registered OpenAPI source:", addSpecResult);

  const exampleTools = yield* executor.tools.list({ sourceId: "example-api" });
  console.log(
    "Tools under 'example-api':",
    exampleTools.map((t) => t.name),
  );

  // Annotations are derived at read time via plugin.resolveAnnotations.
  // GET tools are auto-approved, POST/DELETE require approval:
  console.log(
    "Annotations on example-api tools:",
    exampleTools.map((t) => ({
      name: t.name,
      requiresApproval: t.annotations?.requiresApproval ?? false,
    })),
  );

  // `tools.schema` walks the read path: reads the tool row, attaches
  // matching $defs from the core `definition` table.
  const getItemSchema = yield* executor.tools.schema("example-api.items.get");
  console.log(
    "Schema for items.get has $defs?",
    getItemSchema?.inputSchema &&
      typeof getItemSchema.inputSchema === "object" &&
      "$defs" in getItemSchema.inputSchema,
  );

  // -------------------------------------------------------------------------
  // Dynamic source: GraphQL — introspect via a canned JSON doc so we
  // don't need a real server running.
  // -------------------------------------------------------------------------

  console.log("\n" + "-".repeat(72));
  console.log("Dynamic source: GraphQL");
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

  const gqlResult = yield* executor.graphql.addSource({
    endpoint: "https://example.com/graphql",
    introspectionJson,
    namespace: "example-graphql",
    scope: "example-scope",
  });
  console.log("Registered GraphQL source:", gqlResult);

  const graphqlTools = yield* executor.tools.list({ sourceId: "example-graphql" });
  console.log(
    "Tools under 'example-graphql':",
    graphqlTools.map((t) => ({
      name: t.name,
      requiresApproval: t.annotations?.requiresApproval ?? false,
    })),
  );

  // -------------------------------------------------------------------------
  // MCP, Google Discovery, 1Password — shown but not exercised (they need
  // real external infrastructure). Their extension methods exist, and
  // calling them would register real dynamic sources the same way.
  // -------------------------------------------------------------------------

  console.log("\n" + "-".repeat(72));
  console.log("Other plugin extensions (not exercised in this demo)");
  console.log("-".repeat(72));

  console.log("  executor.keychain.isSupported:", executor.keychain.isSupported);
  console.log("  executor.keychain.displayName:", executor.keychain.displayName);

  console.log("  executor.fileSecrets.filePath:   ", executor.fileSecrets.filePath);

  // executor.mcp.addSource({ connector: { kind: "remote", endpoint: "..." } });
  // executor.googleDiscovery.addSource({ discoveryUrl: "..." });
  // executor.onepassword.configure({ auth: { kind: "desktop-app", accountName: "..." }, vaultId: "..." });

  // -------------------------------------------------------------------------
  // Whole-catalog tools listing + filtering
  // -------------------------------------------------------------------------

  console.log("\n" + "-".repeat(72));
  console.log("Whole catalog");
  console.log("-".repeat(72));

  const allTools = yield* executor.tools.list();
  console.log(`Total tools: ${allTools.length}`);

  const allSources = yield* executor.sources.list();
  console.log(
    `Total sources: ${allSources.length} (${allSources.filter((s) => s.runtime).length} runtime, ${allSources.filter((s) => !s.runtime).length} dynamic)`,
  );

  const mutationTools = yield* executor.tools.list({ query: "create" });
  console.log(
    "Tools matching 'create':",
    mutationTools.map((t) => t.id),
  );

  // -------------------------------------------------------------------------
  // Shutdown — close() is called on every plugin that declared a `close`
  // hook (the cache-backed ones like MCP tear down their connection pool).
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
