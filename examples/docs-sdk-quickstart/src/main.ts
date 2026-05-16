// This example is the source of truth for docs snippets on /sdk/quickstart.
// Run `bun run docs:snippets` after editing docs:start/docs:end blocks.
import { createExecutor } from "@executor-js/sdk/promise";
import { openApiPlugin } from "@executor-js/plugin-openapi/promise";

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
const executor = await createExecutor({
  scopes: [{ id: "docs-workspace", name: "Docs Workspace" }],
  plugins: [openApiPlugin()],
  onElicitation: "accept-all",
});
// docs:end create-executor

// docs:start add-source
await executor.openapi.addSpec({
  namespace: "inventory",
  scope: "docs-workspace",
  spec: JSON.stringify(inventoryApi),
});
// docs:end add-source

// docs:start list-tools
const tools = await executor.tools.list({ sourceId: "inventory" });

for (const tool of tools) {
  console.log(`${tool.id}: ${tool.description}`);
}
// docs:end list-tools

// docs:start inspect-schema
const schema = await executor.tools.schema("inventory.listItems");

console.log(schema?.inputTypeScript ?? "No input required");
// docs:end inspect-schema

// docs:start close-executor
await executor.close();
// docs:end close-executor
