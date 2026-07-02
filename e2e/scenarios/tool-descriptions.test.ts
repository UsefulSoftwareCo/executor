// Cross-target: the agent-visible description surface, captured as a
// reviewable artifact. Registers description-rich OpenAPI and GraphQL
// fixtures (every description channel a spec author can use: operation
// summary/description, parameter descriptions, body property descriptions,
// response descriptions, GraphQL field/arg/type docstrings), then dumps what
// an agent actually sees — tools.list entries and the tools.schema view
// (the same compiled TypeScript previews `tools.describe.tool()` returns in
// the sandbox) — into `descriptions.md` / `descriptions.json` in the run dir.
//
// The artifact is the point: change anything in the spec→tool description
// pipeline, run this scenario, and read (or diff) one file instead of
// spinning up an app and clicking around. Fixture slugs are randomized for
// catalog isolation but normalized back out of the artifact so two runs of
// the same code produce identical files.
import { randomBytes, randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import { join } from "node:path";

import { expect } from "@effect/vitest";
import { Effect } from "effect";
import { buildSchema, introspectionFromSchema } from "graphql";
import { composePluginApi } from "@executor-js/api/server";
import { graphqlHttpPlugin } from "@executor-js/plugin-graphql/api";
import { openApiHttpPlugin } from "@executor-js/plugin-openapi/api";
import {
  AuthTemplateSlug,
  ConnectionName,
  IntegrationSlug,
  ProviderItemId,
} from "@executor-js/sdk/shared";

import { scenario } from "../src/scenario";
import { Api, Mcp, RunDir, Target } from "../src/services";

const api = composePluginApi([openApiHttpPlugin(), graphqlHttpPlugin()] as const);

// ---------------------------------------------------------------------------
// Fixtures — every description channel populated, so a drop anywhere in the
// pipeline is visible as "the fixture says X, the artifact doesn't".
// ---------------------------------------------------------------------------

const ordersOpenApiSpec = (baseUrl: string): string =>
  JSON.stringify({
    openapi: "3.0.3",
    info: {
      title: "Orders API",
      version: "1.0.0",
      description: "A fixture API exercising every OpenAPI description channel.",
    },
    servers: [{ url: baseUrl }],
    paths: {
      "/orders/{orderId}": {
        get: {
          operationId: "getOrder",
          summary: "Fetch a single order",
          description:
            "Fetch one order by id, including line items and the current fulfillment status.",
          parameters: [
            {
              name: "orderId",
              in: "path",
              required: true,
              description: "Unique order identifier (ULID).",
              schema: { type: "string" },
            },
            {
              name: "include",
              in: "query",
              description: "Related records to embed in the response.",
              schema: { type: "string", enum: ["items", "customer", "shipments"] },
            },
          ],
          responses: {
            "200": {
              description: "The order, with any requested embeds.",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: {
                      id: { type: "string", description: "Unique order identifier (ULID)." },
                      status: {
                        type: "string",
                        description: "Current fulfillment status.",
                        enum: ["pending", "shipped", "delivered"],
                      },
                      total: {
                        type: "number",
                        description: "Order total in minor currency units (cents).",
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
      "/orders/{orderId}/invoice": {
        get: {
          operationId: "getOrderInvoice",
          summary: "Download an order invoice",
          description: "Download the PDF invoice for an order.",
          parameters: [
            {
              name: "orderId",
              in: "path",
              required: true,
              description: "Unique order identifier (ULID).",
              schema: { type: "string" },
            },
          ],
          responses: {
            "200": {
              description: "The invoice PDF.",
              content: {
                "application/pdf": { schema: { type: "string", format: "binary" } },
              },
            },
          },
        },
      },
      "/orders": {
        post: {
          operationId: "createOrder",
          summary: "Create an order",
          // No `description` on purpose: the tool description must fall back
          // to the summary, and the artifact shows which one won.
          requestBody: {
            required: true,
            description: "The order to create.",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  required: ["items"],
                  properties: {
                    items: {
                      type: "array",
                      description: "Line items to order.",
                      items: {
                        type: "object",
                        properties: {
                          sku: { type: "string", description: "Product SKU." },
                          quantity: {
                            type: "integer",
                            description: "How many units of this SKU.",
                          },
                        },
                      },
                    },
                    note: {
                      type: "string",
                      description: "Free-form note shown to the warehouse packer.",
                    },
                  },
                },
              },
            },
          },
          responses: { "201": { description: "The created order." } },
        },
      },
    },
  });

const ordersGraphqlSdl = /* GraphQL */ `
  """
  A customer order.
  """
  type Order {
    """
    Unique order identifier (ULID).
    """
    id: ID!

    """
    Current fulfillment status.
    """
    status: String!
  }

  type Query {
    """
    Fetch one order by id, including the current fulfillment status.
    """
    order(
      """
      Unique order identifier (ULID).
      """
      id: ID!
    ): Order
  }

  type Mutation {
    """
    Cancel an order that has not shipped yet.
    """
    cancelOrder(
      """
      Unique order identifier (ULID).
      """
      id: ID!
      """
      Human-readable reason, shown to the customer.
      """
      reason: String
    ): Order
  }
`;

const ordersIntrospectionJson = (): string =>
  JSON.stringify({ data: introspectionFromSchema(buildSchema(ordersGraphqlSdl)) });

// ---------------------------------------------------------------------------
// Artifact rendering
// ---------------------------------------------------------------------------

interface ToolSnapshot {
  readonly name: string;
  readonly address: string;
  readonly listDescription: string;
  readonly schemaDescription?: string;
  readonly inputTypeScript?: string;
  readonly outputTypeScript?: string;
  readonly typeScriptDefinitions?: Record<string, string>;
  readonly inputSchema?: unknown;
}

const codeBlock = (lang: string, body: string): string => `\`\`\`${lang}\n${body}\n\`\`\``;

const renderTool = (tool: ToolSnapshot): string => {
  const lines: string[] = [`### \`${tool.name}\``, "", `> ${tool.listDescription || "(empty)"}`];
  if (tool.schemaDescription && tool.schemaDescription !== tool.listDescription) {
    lines.push("", `tools.schema description differs:`, "", `> ${tool.schemaDescription}`);
  }
  if (tool.inputTypeScript) {
    lines.push("", "**Input**", "", codeBlock("ts", tool.inputTypeScript));
  }
  if (tool.outputTypeScript) {
    lines.push("", "**Output**", "", codeBlock("ts", tool.outputTypeScript));
  }
  const definitions = Object.entries(tool.typeScriptDefinitions ?? {});
  if (definitions.length > 0) {
    lines.push("", "**Definitions**", "");
    for (const [name, body] of definitions) {
      lines.push(codeBlock("ts", `type ${name} = ${body}`));
    }
  }
  if (tool.inputSchema !== undefined) {
    lines.push(
      "",
      "<details><summary>Raw inputSchema</summary>",
      "",
      codeBlock("json", JSON.stringify(tool.inputSchema, null, 2)),
      "",
      "</details>",
    );
  }
  return lines.join("\n");
};

scenario(
  "Tools · agent-visible descriptions snapshot",
  {},
  Effect.gen(function* () {
    const target = yield* Target;
    const { client } = yield* Api;
    const mcp = yield* Mcp;
    const runDir = yield* RunDir;
    const identity = yield* target.newIdentity();
    const apiClient = yield* client(api, identity);

    // Unique slugs per run keep repeated/parallel runs out of each other's
    // catalogs (selfhost shares the bootstrap-admin identity).
    const nonce = randomBytes(4).toString("hex");
    const openapiSlug = `descr-openapi-${nonce}`;
    const graphqlSlug = `descr-graphql-${nonce}`;
    const specBaseUrl = "http://127.0.0.1:59999"; // never contacted

    const apiKeyTemplate = [
      {
        slug: "apiKey",
        type: "apiKey",
        headers: { "x-api-key": [{ type: "variable", name: "token" }] },
      },
    ] as const;

    const connect = (slug: string) =>
      Effect.gen(function* () {
        const providers = yield* apiClient.providers.list();
        yield* apiClient.connections.create({
          payload: {
            owner: "org",
            name: ConnectionName.make("main"),
            integration: IntegrationSlug.make(slug),
            template: AuthTemplateSlug.make("apiKey"),
            from: { provider: providers[0]!, id: ProviderItemId.make(randomUUID()) },
          },
        });
      });

    const cleanup = (slug: string) =>
      Effect.gen(function* () {
        yield* apiClient.connections
          .remove({
            params: {
              owner: "org",
              integration: IntegrationSlug.make(slug),
              name: ConnectionName.make("main"),
            },
          })
          .pipe(Effect.ignore);
        yield* apiClient.integrations
          .remove({ params: { slug: IntegrationSlug.make(slug) } })
          .pipe(Effect.ignore);
      });

    yield* Effect.ensuring(
      Effect.gen(function* () {
        const added = yield* apiClient.openapi.addSpec({
          payload: {
            spec: { kind: "blob", value: ordersOpenApiSpec(specBaseUrl) },
            slug: openapiSlug,
            baseUrl: specBaseUrl,
            authenticationTemplate: apiKeyTemplate,
          },
        });
        expect(added.toolCount, "the OpenAPI fixture's operations became tools").toBe(3);

        // Description set AT ADD (the add form's field) — no PATCH needed.
        yield* apiClient.graphql.addIntegration({
          payload: {
            endpoint: `${specBaseUrl}/graphql`,
            slug: graphqlSlug,
            description: "Order management over GraphQL.",
            introspectionJson: ordersIntrospectionJson(),
            authenticationTemplate: apiKeyTemplate,
          },
        });

        yield* connect(openapiSlug);
        yield* connect(graphqlSlug);

        // Add-time prefill: with neither passed, the spec's title becomes the
        // display name and its `info.description` the description.
        const openapiIntegration = yield* apiClient.integrations.get({
          params: { slug: IntegrationSlug.make(openapiSlug) },
        });
        expect(openapiIntegration.name, "the spec title prefills the name").toBe("Orders API");
        expect(
          openapiIntegration.description,
          "the spec's info.description prefills the description",
        ).toBe("A fixture API exercising every OpenAPI description channel.");

        // The agent-visible surface: catalog entry + schema view (the same
        // data `tools.search()` / `tools.describe.tool()` serve the sandbox).
        const snapshotFor = (slug: string) =>
          Effect.gen(function* () {
            const tools = yield* apiClient.tools.list({
              query: { integration: IntegrationSlug.make(slug) },
            });
            return yield* Effect.forEach(
              [...tools].sort((a, b) => a.name.localeCompare(b.name)),
              (tool) =>
                Effect.gen(function* () {
                  const schema = yield* apiClient.tools.schema({
                    query: { address: tool.address },
                  });
                  return {
                    name: tool.name,
                    address: String(tool.address),
                    listDescription: tool.description,
                    schemaDescription: schema.description,
                    inputTypeScript: schema.inputTypeScript,
                    outputTypeScript: schema.outputTypeScript,
                    typeScriptDefinitions: schema.typeScriptDefinitions,
                    inputSchema: schema.inputSchema,
                  } satisfies ToolSnapshot;
                }),
            );
          });

        const openapiTools = yield* snapshotFor(openapiSlug);
        const graphqlTools = yield* snapshotFor(graphqlSlug);

        // The execute tool's description over the real MCP surface — the
        // connected-integration inventory an MCP client (and its model) reads.
        // Only this run's lines: the shared selfhost admin may have other
        // integrations in the inventory.
        const readInventory = () =>
          Effect.map(mcp.session(identity).describeTools(), (mcpTools) =>
            (mcpTools.find((tool) => tool.name === "execute")?.description ?? "")
              .split("## Available integrations")[1]
              ?.split("\n")
              .filter(
                (line) =>
                  line.startsWith("- ") &&
                  (line.includes(openapiSlug) || line.includes(graphqlSlug)),
              )
              .join("\n"),
          );
        const inventory = yield* readInventory();

        // Normalize the per-run randomness so artifacts diff cleanly across
        // runs: slugs become stable tokens, the owner segment a placeholder.
        const owner = (yield* apiClient.tools.list({ query: {} }))
          .map((tool) => String(tool.owner))
          .find((value) => value.length > 0);
        const normalize = (text: string): string => {
          let out = text
            .replaceAll(openapiSlug, "openapi-fixture")
            .replaceAll(graphqlSlug, "graphql-fixture");
          if (owner) out = out.replaceAll(owner, "<owner>");
          return out;
        };

        const sections = [
          ["OpenAPI fixture (`Orders API`)", openapiTools],
          ["GraphQL fixture (orders schema)", graphqlTools],
        ] as const;
        const markdown = normalize(
          [
            `# Agent-visible tool descriptions — ${target.name}`,
            "",
            "What an agent sees for tools derived from description-rich fixtures:",
            "the `tools.list` catalog entry (quoted) and the `tools.schema` view —",
            "the same compiled TypeScript previews `tools.describe.tool()` returns",
            "inside the sandbox. Anything written in the fixture sources (bottom)",
            "but absent here was dropped by the spec→tool pipeline.",
            "",
            ...sections.flatMap(([title, tools]) => [
              `## ${title}`,
              "",
              tools.map(renderTool).join("\n\n"),
              "",
            ]),
            "## Execute-tool inventory (over MCP)",
            "",
            "Integration slug lines from the `execute` tool's description,",
            "as an MCP client reads them (names only, deduped across connections).",
            "",
            codeBlock("md", inventory ?? "(no inventory section found)"),
            "",
            "## Fixture sources",
            "",
            "<details><summary>OpenAPI spec</summary>",
            "",
            codeBlock("json", JSON.stringify(JSON.parse(ordersOpenApiSpec(specBaseUrl)), null, 2)),
            "",
            "</details>",
            "",
            "<details><summary>GraphQL SDL</summary>",
            "",
            codeBlock("graphql", ordersGraphqlSdl.trim()),
            "",
            "</details>",
            "",
          ].join("\n"),
        );
        writeFileSync(join(runDir, "descriptions.md"), markdown);
        writeFileSync(
          join(runDir, "descriptions.json"),
          normalize(
            JSON.stringify(
              {
                target: target.name,
                openapi: openapiTools,
                graphql: graphqlTools,
                executeInventory: inventory ?? null,
              },
              null,
              2,
            ),
          ),
        );

        // Lock the channels that flow today; the artifact is the review
        // surface for the ones that don't (yet).
        const byName = (tools: readonly ToolSnapshot[], name: string) =>
          tools.find((tool) => tool.name === name);

        const getOrder = byName(openapiTools, "orders.getOrder");
        expect(getOrder?.listDescription, "operation description reaches the tool").toBe(
          "Fetch one order by id, including line items and the current fulfillment status.",
        );
        const createOrder = byName(openapiTools, "orders.createOrder");
        expect(createOrder?.listDescription, "summary is the fallback description").toBe(
          "Create an order",
        );
        expect(getOrder?.inputTypeScript, "input shape is compiled to TypeScript").toContain(
          "orderId",
        );

        // A file-returning operation carries the emit contract in its stored
        // description, so it rides BOTH the catalog (tools.list / tools.search,
        // the step a model always walks) and the schema view, without the
        // model having to read the ToolFile output schema to discover emit().
        const getInvoice = byName(openapiTools, "orders.getOrderInvoice");
        expect(getInvoice?.listDescription, "the file tool keeps its own description").toContain(
          "Download the PDF invoice for an order.",
        );
        expect(
          getInvoice?.listDescription,
          "the file tool's catalog description carries the emit contract",
        ).toContain("emit(result.data)");
        expect(
          getInvoice?.schemaDescription,
          "the file tool's schema description carries the emit contract",
        ).toContain("emit(result.data)");
        expect(
          getInvoice?.outputTypeScript,
          "the file tool's output is the ToolFile envelope",
        ).toContain("ToolFile");
        // Targeted, not blanket: a non-file tool's description stays clean.
        expect(getOrder?.listDescription, "a non-file tool is untouched").not.toContain(
          "emit(result.data)",
        );

        const orderQuery = byName(graphqlTools, "query.order");
        expect(orderQuery?.listDescription, "GraphQL field docstring reaches the tool").toBe(
          "Fetch one order by id, including the current fulfillment status.",
        );
        const cancelOrder = byName(graphqlTools, "mutation.cancelOrder");
        expect(cancelOrder?.inputTypeScript, "GraphQL args are compiled to TypeScript").toContain(
          "reason",
        );

        // The execute-tool inventory lists connected integration slugs only
        // (no connection prefixes, no descriptions) — see formatIntegrationInventory.
        expect(inventory, "the OpenAPI fixture appears in the MCP inventory").toContain(
          `- \`${openapiSlug}\``,
        );
        expect(inventory, "the GraphQL fixture appears in the MCP inventory").toContain(
          `- \`${graphqlSlug}\``,
        );
        expect(
          inventory,
          "inventory lines are bare slugs, not connection-prefix paths",
        ).not.toMatch(/\.org\.main/);
      }),
      Effect.gen(function* () {
        yield* cleanup(openapiSlug);
        yield* cleanup(graphqlSlug);
      }),
    );
  }),
);
