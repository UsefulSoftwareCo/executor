// ---------------------------------------------------------------------------
// generateOpenApiSpec: catalog -> OpenAPI 3.1 document.
//
// The document is the interop artifact of `executor generate`: it must hold
// up under other people's tooling, so beyond shape assertions these tests
// run the real `openapi-typescript` generator over the output in the scale
// suite (packages/plugins/openapi/src/sdk/typegen-scale.test.ts). Here:
//   - one POST operation per tool at /tools/invoke/{path}, request body from
//     the input schema, envelope responses referencing shared components,
//   - shared $defs hoisted to namespaced components.schemas with refs
//     rewritten, per-connection namespaces so equal names don't collide,
//   - operationIds unique and identifier-safe, static tools included,
//   - schema-less tools get no requestBody and an unconstrained data shape.
// ---------------------------------------------------------------------------

import { describe, expect, it } from "@effect/vitest";

import { ConnectionName, IntegrationSlug, ToolAddress } from "./ids";
import { generateOpenApiSpec } from "./specgen";
import type { ToolCatalogExport } from "./types";

type ConnectionExport = ToolCatalogExport["connections"][number];
type ToolExport = ConnectionExport["tools"][number];

const connectionExport = (input: {
  owner: "org" | "user";
  integration: string;
  connection: string;
  definitions?: Record<string, unknown>;
  tools: ReadonlyArray<{
    address: string;
    name: string;
    description?: string;
    inputSchema?: unknown;
    outputSchema?: unknown;
    static?: boolean;
  }>;
}): ConnectionExport => ({
  owner: input.owner,
  integration: IntegrationSlug.make(input.integration),
  connection: ConnectionName.make(input.connection),
  ...(input.definitions !== undefined ? { definitions: input.definitions } : {}),
  tools: input.tools.map(
    (tool): ToolExport => ({
      ...tool,
      address: ToolAddress.make(tool.address),
    }),
  ),
});

const catalog = (connections: readonly ConnectionExport[]): ToolCatalogExport => ({ connections });

const githubConnection = connectionExport({
  owner: "org",
  integration: "github",
  connection: "main",
  definitions: {
    User: {
      type: "object",
      properties: { id: { type: "string" }, login: { type: "string" } },
      required: ["id"],
    },
  },
  tools: [
    {
      address: "tools.github.org.main.issues.create",
      name: "issues.create",
      description: "Create an issue\n\nLonger description body.",
      inputSchema: {
        type: "object",
        properties: { title: { type: "string" }, assignee: { $ref: "#/$defs/User" } },
        required: ["title"],
      },
      outputSchema: {
        type: "object",
        properties: { number: { type: "number" }, user: { $ref: "#/$defs/User" } },
      },
    },
    {
      address: "tools.github.org.main.repos.get",
      name: "repos.get",
    },
  ],
});

type SpecDocument = {
  openapi: string;
  servers: ReadonlyArray<{ url: string }>;
  paths: Record<string, { post: Record<string, unknown> }>;
  components: { schemas: Record<string, unknown> };
};

const asDocument = (document: Record<string, unknown>): SpecDocument =>
  // oxlint-disable-next-line executor/no-double-cast -- test boundary: narrow the generated document to the fields these assertions read
  document as unknown as SpecDocument;

describe("generateOpenApiSpec", () => {
  it("emits one POST operation per tool with namespaced component refs", () => {
    const generated = generateOpenApiSpec(catalog([githubConnection]), {
      serverUrl: "http://example.test:4788/api",
    });
    expect(generated.toolCount).toBe(2);
    const document = asDocument(generated.document);

    expect(document.openapi).toBe("3.1.0");
    expect(document.servers).toEqual([{ url: "http://example.test:4788/api" }]);

    const create = document.paths["/tools/invoke/github.org.main.issues.create"]?.post;
    expect(create).toBeDefined();
    expect(create!.operationId).toBe("github_org_main_issues_create");
    expect(create!.summary).toBe("Create an issue");

    // The input schema is inline; its $defs refs point at the namespaced
    // component.
    const requestBody = create!.requestBody as {
      required: boolean;
      content: { "application/json": { schema: { properties: { assignee: { $ref: string } } } } };
    };
    expect(requestBody.required).toBe(true);
    expect(requestBody.content["application/json"].schema.properties.assignee.$ref).toBe(
      "#/components/schemas/github.org.main.User",
    );

    // Shared definition hoisted once, under the connection namespace.
    expect(document.components.schemas["github.org.main.User"]).toMatchObject({
      type: "object",
      required: ["id"],
    });
    // Envelope schemas present.
    expect(document.components.schemas.ExecutorToolError).toBeDefined();
    expect(document.components.schemas.ExecutorToolHttpMeta).toBeDefined();

    // Schema-less tool: no requestBody, still has the envelope response.
    const get = document.paths["/tools/invoke/github.org.main.repos.get"]?.post;
    expect(get).toBeDefined();
    expect(get!.requestBody).toBeUndefined();
    expect(get!.responses).toMatchObject({ "200": {}, "404": {} });
  });

  it("keeps equal definition names from different connections apart", () => {
    const other = connectionExport({
      owner: "user",
      integration: "linear",
      connection: "personal",
      definitions: {
        User: { type: "object", properties: { email: { type: "string" } } },
      },
      tools: [
        {
          address: "tools.linear.user.personal.me",
          name: "me",
          outputSchema: { $ref: "#/$defs/User" },
        },
      ],
    });

    const document = asDocument(generateOpenApiSpec(catalog([githubConnection, other])).document);
    expect(document.components.schemas["github.org.main.User"]).toMatchObject({
      required: ["id"],
    });
    expect(document.components.schemas["linear.user.personal.User"]).toMatchObject({
      properties: { email: { type: "string" } },
    });
  });

  it("dedupes colliding operationIds", () => {
    const collisions = connectionExport({
      owner: "org",
      integration: "demo",
      connection: "main",
      tools: [
        { address: "tools.demo.org.main.a.b", name: "a.b" },
        // Same sanitized operationId as a.b.
        { address: "tools.demo.org.main.a_b", name: "a_b" },
      ],
    });
    const document = asDocument(generateOpenApiSpec(catalog([collisions])).document);
    const ids = Object.values(document.paths).map((entry) => entry.post.operationId);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
