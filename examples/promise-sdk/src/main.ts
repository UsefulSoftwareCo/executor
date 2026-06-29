/**
 * Example: Promise-based executor SDK with MCP, OpenAPI, and GraphQL
 * — no Effect knowledge or database setup needed. Uses the SDK's
 * ephemeral in-memory FumaDB backend by default.
 *
 * v2 model: an *integration* is the API surface (added via the plugin's
 * extension), and a *connection* is the credential for that integration. Tools
 * are produced per connection and addressed as
 * `tools.<integration>.<owner>.<connection>.<tool>`. A connection's value lives
 * in a writable CredentialProvider — here a tiny in-memory store registered via
 * `providers`. There is no separate secret store: a connection *is* the secret.
 */
import {
  createExecutor,
  ProviderItemId,
  ProviderKey,
  type CredentialProvider,
} from "@executor-js/sdk/promise";
import { Effect } from "effect";
import { mcpPlugin } from "@executor-js/plugin-mcp/promise";
import { openApiPlugin, variable } from "@executor-js/plugin-openapi/promise";
import { graphqlPlugin } from "@executor-js/plugin-graphql/promise";

// ---------------------------------------------------------------------------
// 1. Create the executor with all plugins
//
// A connection stores its value in a writable credential provider. This tiny
// in-memory store is enough for a script; production hosts swap in a durable
// provider (keychain, 1Password, an encrypted DB store). Providers are
// Effect-native, so `get`/`set` return `Effect`s.
// ---------------------------------------------------------------------------

const plugins = [mcpPlugin(), openApiPlugin(), graphqlPlugin()] as const;

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

const executor = await createExecutor({
  plugins,
  providers: [memoryProvider],
  onElicitation: "accept-all",
});

// ---------------------------------------------------------------------------
// 2. MCP — register a remote server as an integration, then connect to it.
//
// `addServer` registers the catalog entry; `connections.create` produces the
// per-connection tools. Context7 needs no credential, so the connection's value
// is an empty string applied through the "none" template.
// ---------------------------------------------------------------------------

const context7 = await executor.mcp.addServer({
  transport: "remote",
  name: "Context7",
  endpoint: "https://mcp.context7.com/mcp",
  slug: "context7",
});

await executor.connections.create({
  owner: "org",
  name: "default",
  integration: context7.slug,
  template: "none",
  value: "",
});

// Stdio server (disabled by default — pass `dangerouslyAllowStdioMCP: true` to
// mcpPlugin() to enable, only for trusted local contexts):
// await executor.mcp.addServer({
//   transport: "stdio",
//   name: "My Server",
//   command: "npx",
//   args: ["-y", "@my/mcp-server"],
//   slug: "my-server",
// });

// ---------------------------------------------------------------------------
// 3. OpenAPI — load a spec by URL as an integration, then connect.
//
// Petstore is public, so the connection carries a throwaway value. To require a
// real key, declare an `authenticationTemplate` (see Stripe below) and create a
// connection whose `value` is the token.
// ---------------------------------------------------------------------------

await executor.openapi.addSpec({
  spec: {
    kind: "url",
    url: "https://petstore3.swagger.io/api/v3/openapi.json",
  },
  slug: "petstore",
  description: "Petstore",
  baseUrl: "https://petstore3.swagger.io/api/v3",
});

await executor.connections.create({
  owner: "org",
  name: "default",
  integration: "petstore",
  template: "none",
  value: "",
});

// Auth-backed integration: declare where the connection's value renders (here an
// `Authorization: Bearer <token>` header), then create a connection with the
// real token. The value is written to the `memory` provider and applied to the
// template lazily, per request — never pre-baked into the spec.
// await executor.openapi.addSpec({
//   spec: { kind: "url", url: "https://raw.githubusercontent.com/.../stripe.json" },
//   slug: "stripe",
//   authenticationTemplate: [
//     {
//       slug: "bearer",
//       type: "apiKey",
//       headers: { Authorization: ["Bearer ", variable("token")] },
//     },
//   ],
// });
// await executor.connections.create({
//   owner: "org",
//   name: "default",
//   integration: "stripe",
//   template: "bearer",
//   value: "sk_live_...",
// });
void variable; // referenced by the commented authoring example above

// ---------------------------------------------------------------------------
// 4. GraphQL — introspect an endpoint as an integration, then connect.
// ---------------------------------------------------------------------------

await executor.graphql.addIntegration({
  endpoint: "https://graphql.anilist.co",
  name: "AniList",
  slug: "anilist",
});

await executor.connections.create({
  owner: "org",
  name: "default",
  integration: "anilist",
  template: "none",
  value: "",
});

// ---------------------------------------------------------------------------
// 5. Unified tool catalog — all plugins, one list, addressed per connection.
// ---------------------------------------------------------------------------

const tools = await executor.tools.list();
console.log(`\n${tools.length} tools across all plugins:`);
for (const t of tools) {
  console.log(`  [${t.pluginId}] ${t.address} — ${t.description}`);
}

const firstPetstoreTool = tools.find((t) => t.integration === "petstore");
if (firstPetstoreTool) {
  const schema = await executor.tools.schema(firstPetstoreTool.address);
  console.log(`\n${firstPetstoreTool.name} input: ${schema?.inputTypeScript ?? "<none>"}`);
}

// ---------------------------------------------------------------------------
// 6. Execute tools — same interface regardless of plugin. The executor resolves
// the connection's credential and hands it to the owning plugin.
// ---------------------------------------------------------------------------

const anilistTool = tools.find((t) => t.integration === "anilist");
if (anilistTool) {
  const result = await executor.execute(anilistTool.address, {});
  console.log("\nResult:", result);
}

// ---------------------------------------------------------------------------
// 7. Connections are the credentials — list and inspect them across all plugins.
// (v2 has no separate `executor.secrets`; a connection IS the saved credential,
// and its value lives in a registered provider.)
// ---------------------------------------------------------------------------

const connections = await executor.connections.list();
console.log(`\n${connections.length} connections:`);
for (const c of connections) {
  console.log(`  ${c.address} (provider: ${c.provider})`);
}

await executor.close();
