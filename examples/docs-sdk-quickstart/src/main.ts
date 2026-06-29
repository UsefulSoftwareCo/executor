// This example is the source of truth for docs snippets on /sdk/quickstart.
// Run `bun run docs:snippets` after editing docs:start/docs:end blocks.
import { Effect } from "effect";
import {
  createExecutor,
  ProviderItemId,
  ProviderKey,
  type CredentialProvider,
} from "@executor-js/sdk/promise";
import { openApiPlugin, variable } from "@executor-js/plugin-openapi/promise";

const inventoryApi = {
  openapi: "3.0.0",
  info: {
    title: "Inventory API",
    version: "1.0.0",
  },
  servers: [{ url: "https://inventory.example.test" }],
  paths: {
    "/items": {
      get: {
        operationId: "listItems",
        summary: "List inventory items",
        responses: {
          "200": {
            description: "Inventory items",
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
    },
    "/items/{id}": {
      get: {
        operationId: "getItem",
        summary: "Get an inventory item",
        parameters: [
          {
            name: "id",
            in: "path",
            required: true,
            schema: { type: "string" },
          },
        ],
        responses: {
          "200": {
            description: "Inventory item",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/Item" },
              },
            },
          },
        },
      },
    },
  },
  components: {
    schemas: {
      Item: {
        type: "object",
        required: ["id", "name"],
        properties: {
          id: { type: "string" },
          name: { type: "string" },
        },
      },
    },
  },
};

// docs:start create-executor
// A connection stores its value in a writable credential provider. This tiny
// in-memory store is enough for a script; production hosts swap in a durable
// provider (keychain, 1Password, an encrypted DB store, …). Providers are
// Effect-native, so `get`/`set` return `Effect`s.
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
  plugins: [openApiPlugin()],
  providers: [memoryProvider],
  onElicitation: "accept-all",
});
// docs:end create-executor

// docs:start add-integration
// An integration is the API surface. The auth template declares where a
// connection's credential is placed on each request — here, an `X-API-Key`
// header. `variable("token")` is the slot the resolved credential renders into.
await executor.openapi.addSpec({
  slug: "inventory",
  description: "Inventory API",
  baseUrl: "https://inventory.example.com",
  spec: {
    kind: "blob",
    value: JSON.stringify(inventoryApi),
  },
  authenticationTemplate: [
    {
      slug: "apiKey",
      type: "apiKey",
      headers: { "X-API-Key": [variable("token")] },
    },
  ],
});
// docs:end add-integration

// docs:start create-connection
// Tools are produced per connection. A connection is the saved credential for
// one integration; creating one with an inline `value` writes it to the default
// writable provider and yields the integration's tools.
await executor.connections.create({
  owner: "org",
  name: "default",
  integration: "inventory",
  template: "apiKey",
  value: "inventory-api-key",
});
// docs:end create-connection

// docs:start list-tools
const tools = await executor.tools.list({ integration: "inventory" });

for (const tool of tools) {
  console.log(`${tool.address}: ${tool.description}`);
}
// docs:end list-tools

// docs:start inspect-schema
const firstAddress = tools[0]?.address;
const schema = firstAddress ? await executor.tools.schema(firstAddress) : null;

console.log(schema?.inputTypeScript ?? "No input required");
// docs:end inspect-schema

// docs:start close-executor
await executor.close();
// docs:end close-executor
