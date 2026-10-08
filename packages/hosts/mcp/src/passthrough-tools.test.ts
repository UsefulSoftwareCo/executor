import { describe, expect, it } from "@effect/vitest";
import { Effect, Schema } from "effect";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type * as Cause from "effect/Cause";

import type { ExecutionEngine } from "@executor-js/execution";
import {
  ToolAddress,
  IntegrationSlug,
  ConnectionName,
  ToolName,
  type Tool,
  type ToolSchemaView,
} from "@executor-js/sdk";

import { readToolMode } from "./browser-approval";
import {
  COMPACT_ARGUMENT_LIMIT,
  COMPACT_DESCRIPTION_LIMIT,
  compactArguments,
  compactDescription,
  integrationAliasText,
  passthroughCallCode,
  resolveIntegrationAlias,
} from "./passthrough-tools";
import {
  createExecutorMcpServer,
  McpPassthroughUnavailableError,
  type ExecutorMcpServerConfig,
  type McpToolsPort,
} from "./tool-server";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const projection = (input: {
  readonly integration: string;
  readonly name: string;
  readonly owner?: "org" | "user";
  readonly connection?: string;
  readonly description?: string;
  readonly inputSchema?: unknown;
  readonly requiresApproval?: boolean;
  readonly static?: boolean;
}): Tool => {
  const owner = input.owner ?? "org";
  const connection = input.connection ?? "main";
  return {
    address: ToolAddress.make(`tools.${input.integration}.${owner}.${connection}.${input.name}`),
    integration: IntegrationSlug.make(input.integration),
    owner,
    connection: ConnectionName.make(connection),
    name: ToolName.make(input.name),
    pluginId: "test",
    description: input.description ?? `${input.integration} ${input.name}`,
    ...(input.inputSchema === undefined ? {} : { inputSchema: input.inputSchema }),
    ...(input.requiresApproval === undefined
      ? {}
      : { annotations: { requiresApproval: input.requiresApproval } }),
    ...(input.static === undefined ? {} : { static: input.static }),
  };
};

/** Exercise the existing list/schema seam and record which schemas were requested. */
const toolPort = (
  catalog: readonly Tool[],
  schemaReads: string[] = [],
  lists: string[] = [],
  batches: string[][] = [],
): McpToolsPort => {
  const port: McpToolsPort = {
    list: (filter) =>
      Effect.sync(() => {
        lists.push("list");
        return catalog.filter(
          (tool) =>
            (filter?.integration === undefined || tool.integration === filter.integration) &&
            (filter?.owner === undefined || tool.owner === filter.owner) &&
            (filter?.connection === undefined || tool.connection === filter.connection),
        );
      }),
    schema: (address) =>
      Effect.sync(() => {
        schemaReads.push(String(address));
        const tool = catalog.find((item) => item.address === address);
        if (!tool) return null;
        return {
          address,
          name: tool.name,
          description: tool.description,
          inputSchema: tool.inputSchema,
          annotations: tool.annotations,
        } satisfies ToolSchemaView;
      }),
    // The batched read answers per address exactly as `schema` would.
    schemas: (addresses, options) =>
      Effect.suspend(() => {
        batches.push(addresses.map(String));
        return Effect.forEach(addresses, (address) => port.schema(address, options));
      }),
  };
  return port;
};

/** A stub engine that records every executed code string and answers with a
 *  fixed value, so a test can prove a passthrough call became the expected
 *  single-call code and took `execute` (never `executeWithPause`). */
const makeRecordingEngine = (result: unknown = { ok: true, data: { hello: "world" } }) => {
  const executed: string[] = [];
  let pausedCalls = 0;
  const engine: ExecutionEngine = {
    execute: (code) =>
      Effect.sync(() => {
        executed.push(code);
        return { result };
      }),
    executeWithPause: () =>
      Effect.sync(() => {
        pausedCalls += 1;
        return { status: "completed" as const, result: { result } };
      }),
    resume: () => Effect.succeed(null),
    isExecutionSettled: undefined,
    getPausedExecution: () => Effect.succeed(null),
    pausedExecutionCount: () => Effect.succeed(0),
    hasPausedExecutions: () => Effect.succeed(false),
    getDescription: Effect.succeed("test executor"),
    shutdown: Effect.void,
  };
  return { engine, executed, pausedCalls: () => pausedCalls };
};

const withClient = async <E extends Cause.YieldableError>(
  config: ExecutorMcpServerConfig<E>,
  fn: (client: Client) => Promise<void>,
) => {
  const mcpServer = await Effect.runPromise(
    createExecutorMcpServer({
      connections: { list: () => Effect.succeed([]) },
      integrations: { list: () => Effect.succeed([]) },
      ...config,
    }),
  );
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test-client", version: "1.0.0" }, { capabilities: {} });
  await mcpServer.connect(serverTransport);
  await client.connect(clientTransport);
  // oxlint-disable-next-line executor/no-try-catch-or-throw -- boundary: test helper must close MCP transports after async client assertions
  try {
    await fn(client);
  } finally {
    await clientTransport.close();
    await serverTransport.close();
  }
};

const decodeJsonString = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.String));
const decodeJsonRecord = Schema.decodeUnknownSync(
  Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown)),
);

const decodeSearchItems = Schema.decodeUnknownSync(
  Schema.Struct({ items: Schema.Array(Schema.Struct({ id: Schema.String })) }),
);

const CATALOG: readonly Tool[] = [
  projection({
    integration: "github",
    name: "issues.create",
    requiresApproval: true,
    inputSchema: {
      type: "object",
      properties: { title: { type: "string" }, body: { $ref: "#/$defs/Body" } },
      required: ["title"],
      $defs: { Body: { type: "string" } },
    },
  }),
  projection({ integration: "github", name: "issues.list" }),
  projection({ integration: "linear", name: "issueCreate", requiresApproval: true }),
];

describe("passthrough catalog", () => {
  it("emits exactly one awaited tool call with the whole address as one string literal", () => {
    expect(passthroughCallCode("tools.github.org.main.issues.create", { title: "hi" })).toBe(
      'return await tools["github.org.main.issues.create"]({"title":"hi"});',
    );
    expect(passthroughCallCode("linear.org.main.issueCreate", undefined)).toBe(
      'return await tools["linear.org.main.issueCreate"]({});',
    );
    // `then` is reserved by every sandbox proxy; as part of one key it is
    // just text, so such a tool stays callable.
    expect(passthroughCallCode("tools.svc.org.main.items.then", {})).toBe(
      'return await tools["svc.org.main.items.then"]({});',
    );
  });

  it("keeps a hostile tool segment as data, never as code", () => {
    // An OpenAPI spec controls its tool paths (`x-executor-toolPath`), so a
    // segment can contain anything. It must land inside a JSON string.
    const hostile = 'x"](await tools.victim.org.main.destroy({}))["';
    const code = passthroughCallCode(`tools.evil.org.main.${hostile}`, {});
    // Structural proof the payload never escapes the string literal: the
    // source is exactly `return await tools[<one JSON string>](<JSON>);`, and
    // that one string decodes back to the raw address.
    const shape = /^return await tools\[("(?:[^"\\]|\\.)*")\]\((\{.*\})\);$/s.exec(code);
    expect(shape).not.toBeNull();
    expect(decodeJsonString(shape![1]!)).toBe(`evil.org.main.${hostile}`);
    // And the call's argument is the JSON we passed, untouched by the address.
    expect(decodeJsonRecord(shape![2]!)).toEqual({});
  });
});

// ---------------------------------------------------------------------------
// Wire flags
// ---------------------------------------------------------------------------

describe("integration aliases", () => {
  const catalog = [
    { slug: "google_gmail", name: "Gmail", description: "Send and read mail" },
    { slug: "google_calendar", name: "Google Calendar", description: "Events and calendars" },
    { slug: "cloudflare-dns", name: "Cloudflare DNS", description: "Zones and records" },
    { slug: "scrape_api", name: "ScrapeCreators", description: "Social media scraping" },
    { slug: "plex", name: "Plex", description: "Media server" },
  ];

  it("resolves exact slugs, squashed names, word subsets, then descriptions", () => {
    expect(resolveIntegrationAlias("plex", catalog)).toEqual({ kind: "exact", slug: "plex" });
    expect(resolveIntegrationAlias("gmail", catalog)).toEqual({
      kind: "alias",
      slug: "google_gmail",
    });
    expect(resolveIntegrationAlias("Google Calendar", catalog)).toEqual({
      kind: "alias",
      slug: "google_calendar",
    });
    expect(resolveIntegrationAlias("googlegmail", catalog)).toEqual({
      kind: "alias",
      slug: "google_gmail",
    });
    expect(resolveIntegrationAlias("cloudflare_dns", catalog)).toEqual({
      kind: "alias",
      slug: "cloudflare-dns",
    });
    expect(resolveIntegrationAlias("scrapecreators", catalog)).toEqual({
      kind: "alias",
      slug: "scrape_api",
    });
    expect(resolveIntegrationAlias("mail", catalog)).toEqual({
      kind: "alias",
      slug: "google_gmail",
    });
    expect(resolveIntegrationAlias("google", catalog)).toEqual({
      kind: "ambiguous",
      slugs: ["google_calendar", "google_gmail"],
    });
    expect(resolveIntegrationAlias("notion", catalog)).toEqual({ kind: "none" });
    expect(resolveIntegrationAlias("  ", catalog)).toEqual({ kind: "none" });
  });

  it("adds display-name words the slug lacks as ranking text", () => {
    expect([...integrationAliasText(catalog)]).toEqual([
      ["google_calendar", "googlecalendar"],
      ["cloudflare-dns", "cloudflaredns"],
      ["scrape_api", "creators scrapecreators"],
    ]);
  });
});

describe("compact search hits", () => {
  it("keeps the first sentence of a description within the limit", () => {
    expect(compactDescription(undefined)).toBe("");
    expect(compactDescription("  \nList DNS records. Supports paging.\nMore.")).toBe(
      "List DNS records.",
    );
    expect(compactDescription("No. Period means something else here, keep going")).toBe(
      "No. Period means something else here, keep going",
    );
    const long = `Create ${"x".repeat(400)} end`;
    const compact = compactDescription(long);
    expect(compact.length).toBe(COMPACT_DESCRIPTION_LIMIT);
    expect(compact.endsWith("…")).toBe(true);
  });

  it("summarizes arguments with types, required first, enums, arrays, refs and a cap", () => {
    expect(compactArguments(undefined)).toBe("none");
    expect(compactArguments({ type: "object" })).toBe("none");
    expect(compactArguments({ oneOf: [{ type: "string" }, { type: "object" }] })).toBe(
      "see full schema",
    );
    expect(
      compactArguments(
        {
          type: "object",
          properties: {
            optional: { type: ["string", "null"] },
            zone: { $ref: "#/$defs/Zone" },
            kind: { enum: ["A", "AAAA", "CNAME", "MX", "TXT", "NS", "SRV"] },
            tags: { type: "array", items: { $ref: "#/$defs/Tag" } },
            either: { anyOf: [{ type: "string" }, { type: "number" }] },
            nested: { properties: { a: { type: "string" } } },
            body: {
              type: "object",
              properties: { text: { type: "string" }, title: { type: "string" } },
              required: ["text"],
            },
            fixed: { const: 7 },
          },
          required: ["zone", "kind"],
        },
        { Zone: { type: "string" }, Tag: { type: "object", properties: {} } },
      ),
    ).toBe(
      "zone (string, required); kind (A|AAAA|CNAME|MX|TXT|NS|…, required); optional (string); tags (object[]); either (string|number); nested (object{a}); body (object{text*, title}); fixed (7)",
    );
    const wideBody = Object.fromEntries(
      Array.from({ length: 9 }, (_, i) => [`k${i}`, { type: "string" }]),
    );
    expect(
      compactArguments({
        type: "object",
        properties: { body: { type: "object", properties: wideBody } },
      }),
    ).toBe("body (object{k0, k1, k2, k3, k4, k5, +3})");
    const wide = Object.fromEntries(
      Array.from({ length: COMPACT_ARGUMENT_LIMIT + 3 }, (_, i) => [`p${i}`, { type: "string" }]),
    );
    const summary = compactArguments({ type: "object", properties: wide });
    expect(summary.split("; ")).toHaveLength(COMPACT_ARGUMENT_LIMIT + 1);
    expect(summary.endsWith("; +3 more")).toBe(true);
  });
});

describe("readToolMode", () => {
  const request = (query: string) => new Request(`https://example.test/mcp${query}`);

  it("defaults to codemode and only accepts the exact passthrough spelling", () => {
    expect(readToolMode(request(""))).toBe("codemode");
    expect(readToolMode(request("?mode=passthrough"))).toBe("passthrough");
    expect(readToolMode(request("?mode=Passthrough"))).toBe("codemode");
    expect(readToolMode(request("?mode=direct"))).toBe("codemode");
  });
});

// ---------------------------------------------------------------------------
// Server: the served surface
// ---------------------------------------------------------------------------

describe("passthrough mode server", () => {
  it("lists live account metadata with paging, exact filters, and no schemas or secrets", async () => {
    const { engine, executed } = makeRecordingEngine();
    const schemaReads: string[] = [];
    const lists: string[] = [];
    const reads: string[] = [];
    const account = (integration: string, owner: "org" | "user", name: string) => ({
      integration,
      owner,
      name,
      identityLabel: "Example account",
      description: "Use for test issues",
      lastHealth: {
        status: "healthy" as const,
        checkedAt: 123,
        detail: "private probe details",
        responseSample: [{ path: "token", value: "secret" }],
      },
      oauthScope: "private grants",
      provider: "private credential provider",
    });
    let accounts = [
      account("github", "user", "main"),
      account("github", "org", "main"),
      account("github_other", "org", "main"),
      account("unavailable", "org", "hidden"),
    ];
    await withClient(
      {
        engine,
        mode: "passthrough",
        tools: toolPort(CATALOG, schemaReads, lists),
        connections: {
          list: () =>
            Effect.sync(() => {
              reads.push("connections");
              return accounts;
            }),
        },
        integrations: {
          list: () =>
            Effect.sync(() => {
              reads.push("integrations");
              return [
                {
                  slug: IntegrationSlug.make("github"),
                  name: "GitHub",
                  description: "Issues and repositories",
                },
                {
                  slug: IntegrationSlug.make("github_other"),
                  name: "Other GitHub",
                  description: "Another integration",
                },
                {
                  slug: IntegrationSlug.make("not_connected"),
                  name: "Not connected",
                  description: "No account",
                },
              ];
            }),
        },
      },
      async (client) => {
        await client.listTools();
        expect(reads).toEqual([]);
        const first = await client.callTool({
          name: "integrations",
          arguments: { integration: "github", limit: 1 },
        });
        expect(first.structuredContent).toEqual({
          items: [
            {
              integration: "github",
              integrationName: "GitHub",
              integrationDescription: "Issues and repositories",
              owner: "org",
              connection: "main",
              identityLabel: "Example account",
              description: "Use for test issues",
              lastHealth: { status: "healthy", checkedAt: 123 },
            },
          ],
          total: 2,
          hasMore: true,
          nextOffset: 1,
        });
        const next = await client.callTool({
          name: "integrations",
          arguments: { integration: "github", limit: 1, offset: 1 },
        });
        expect(next.structuredContent).toMatchObject({
          items: [{ owner: "user" }],
          total: 2,
          hasMore: false,
          nextOffset: null,
        });
        const filtered = await client.callTool({
          name: "integrations",
          arguments: { owner: "org", integration: "github" },
        });
        expect(filtered.structuredContent).toMatchObject({
          items: [{ owner: "org", integration: "github" }],
          total: 1,
        });
        const all = await client.callTool({ name: "integrations", arguments: {} });
        expect(all.structuredContent).toMatchObject({ total: 3 });
        expect(JSON.stringify(all)).not.toContain("secret");
        expect(JSON.stringify(all)).not.toContain("private");
        accounts = [];
        const empty = await client.callTool({ name: "integrations", arguments: {} });
        expect(empty.structuredContent).toEqual({
          items: [],
          total: 0,
          hasMore: false,
          nextOffset: null,
        });
        expect(lists).toEqual([]);
        expect(schemaReads).toEqual([]);
        expect(executed).toEqual([]);
      },
    );
  });

  it("reads the execute description only when a guide asks for it", async () => {
    const { engine } = makeRecordingEngine();
    let reads = 0;
    const counting: ExecutionEngine = {
      ...engine,
      getDescription: Effect.sync(() => {
        reads += 1;
        return "test executor\n\n## Available integrations\n- github: issues";
      }),
    };
    await withClient(
      { engine: counting, mode: "passthrough", tools: toolPort(CATALOG) },
      async (client) => {
        // Session setup, the tool list, and a search never touch the inventory.
        expect(reads).toBe(0);
        await client.listTools();
        await client.callTool({ name: "search", arguments: { query: "issues" } });
        expect(reads).toBe(0);
        // The guides read it once per session, then reuse it.
        await client.callTool({ name: "skills", arguments: { name: "search-invoke" } });
        await client.callTool({ name: "skills", arguments: {} });
        expect(reads).toBe(1);
      },
    );
    // Codemode registers the `execute` tool with the description, so it is read at build.
    reads = 0;
    await withClient({ engine: counting }, async (client) => {
      expect(reads).toBe(1);
      const guide = await client.callTool({ name: "skills", arguments: { name: "execute" } });
      expect(JSON.stringify(guide.content)).toContain("## Available integrations");
      expect(reads).toBe(1);
    });
  });

  it("serves only the search/invoke guide as text", async () => {
    const { engine } = makeRecordingEngine();
    await withClient({ engine, mode: "passthrough", tools: toolPort(CATALOG) }, async (client) => {
      const index = await client.callTool({ name: "skills", arguments: {} });
      expect(JSON.stringify(index.content)).toContain("search-invoke");
      expect(JSON.stringify(index.content)).not.toContain("create-artifact");
      const guide = await client.callTool({ name: "skills", arguments: { name: "search-invoke" } });
      expect(guide.structuredContent).toBeUndefined();
      expect(JSON.stringify(guide.content)).toContain("integrations({})");
      expect(JSON.stringify(guide.content)).toContain("nextOffset");
      expect(JSON.stringify(guide.content)).not.toContain("tools.describe");
      for (const name of ["execute", "create-artifact", "artifact-style", "/tmp/SKILL.md"]) {
        expect((await client.callTool({ name: "skills", arguments: { name } })).isError).toBe(true);
      }
    });
  });

  it("filters exact accounts before ranking, pagination, and schema reads", async () => {
    const { engine } = makeRecordingEngine();
    const schemaReads: string[] = [];
    const catalog = [
      projection({ integration: "github", owner: "org", connection: "main", name: "issues.first" }),
      projection({
        integration: "github",
        owner: "org",
        connection: "main",
        name: "issues.second",
      }),
      projection({
        integration: "github",
        owner: "user",
        connection: "main",
        name: "issues.first",
      }),
      projection({
        integration: "github",
        owner: "org",
        connection: "main2",
        name: "issues.first",
      }),
      projection({
        integration: "github_other",
        owner: "org",
        connection: "main",
        name: "issues.first",
      }),
      projection({
        integration: "github",
        owner: "org",
        connection: "main",
        name: "issues.static",
        static: true,
      }),
    ];
    await withClient(
      {
        engine,
        mode: "passthrough",
        tools: toolPort(catalog, schemaReads),
        integrations: {
          list: () =>
            Effect.succeed([
              { slug: IntegrationSlug.make("github"), name: "GitHub", description: "" },
              { slug: IntegrationSlug.make("github_other"), name: "Other", description: "" },
            ]),
        },
      },
      async (client) => {
        const args = {
          query: "issues",
          integration: "github",
          owner: "org",
          connection: "main",
          limit: 1,
        };
        const first = await client.callTool({ name: "search", arguments: args });
        expect(first.structuredContent).toMatchObject({ total: 2, hasMore: true, nextOffset: 1 });
        const next = await client.callTool({ name: "search", arguments: { ...args, offset: 1 } });
        expect(next.structuredContent).toMatchObject({
          total: 2,
          hasMore: false,
          nextOffset: null,
        });
        expect(schemaReads.sort()).toEqual([
          "tools.github.org.main.issues.first",
          "tools.github.org.main.issues.second",
        ]);
        const missing = await client.callTool({
          name: "search",
          arguments: { ...args, connection: "absent" },
        });
        expect(missing.structuredContent).toEqual({
          items: [],
          total: 0,
          hasMore: false,
          nextOffset: null,
        });
        expect(schemaReads).toHaveLength(2);
      },
    );
  });

  it("accepts integration aliases in search and integrations, and ranks by display name", async () => {
    const { engine } = makeRecordingEngine();
    const lists: string[] = [];
    const catalog = [
      projection({ integration: "google_gmail", name: "users.messages.send" }),
      projection({ integration: "google_gmail", name: "users.messages.list" }),
      projection({ integration: "google_calendar", name: "events.list" }),
      projection({
        integration: "scrape_api",
        name: "profiles.get",
        description: "Fetch a profile",
      }),
    ];
    const account = (integration: string) => ({
      integration,
      owner: "org" as const,
      name: "main",
      identityLabel: null,
      description: null,
      lastHealth: null,
    });
    await withClient(
      {
        engine,
        mode: "passthrough",
        tools: toolPort(catalog, [], lists),
        connections: {
          list: () =>
            Effect.succeed([
              account("google_gmail"),
              account("google_calendar"),
              account("scrape_api"),
            ]),
        },
        integrations: {
          list: () =>
            Effect.succeed([
              { slug: IntegrationSlug.make("google_gmail"), name: "Gmail", description: "Mail" },
              {
                slug: IntegrationSlug.make("google_calendar"),
                name: "Google Calendar",
                description: "Events",
              },
              {
                slug: IntegrationSlug.make("scrape_api"),
                name: "ScrapeCreators",
                description: "Scraping",
              },
            ]),
        },
      },
      async (client) => {
        // An alias narrows the list read to the resolved slug and reports it.
        const alias = await client.callTool({
          name: "search",
          arguments: { query: "send", integration: "gmail", limit: 3 },
        });
        expect(alias.structuredContent).toMatchObject({
          integration: "google_gmail",
          total: 1,
          items: [{ id: "tools.google_gmail.org.main.users.messages.send" }],
        });
        // An ambiguous alias searches every candidate and lists them.
        const ambiguous = await client.callTool({
          name: "search",
          arguments: { query: "list", integration: "google" },
        });
        expect(ambiguous.structuredContent).toMatchObject({
          integrations: ["google_calendar", "google_gmail"],
          total: 2,
        });
        expect(
          decodeSearchItems(ambiguous.structuredContent)
            .items.map((item) => item.id)
            .sort(),
        ).toEqual([
          "tools.google_calendar.org.main.events.list",
          "tools.google_gmail.org.main.users.messages.list",
        ]);
        // An unknown value stays an exact filter (no hits) and explains itself.
        const unknown = await client.callTool({
          name: "search",
          arguments: { query: "send", integration: "notion" },
        });
        expect(unknown.structuredContent).toMatchObject({
          items: [],
          total: 0,
          hint: expect.stringContaining('No integration matches "notion"'),
        });
        // Query words naming an integration by display name rank its tools.
        const byName = await client.callTool({
          name: "search",
          arguments: { query: "scrapecreators profile", limit: 3 },
        });
        expect(decodeSearchItems(byName.structuredContent).items.map((item) => item.id)).toEqual([
          "tools.scrape_api.org.main.profiles.get",
        ]);
        // integrations accepts the same aliases.
        const accounts = await client.callTool({
          name: "integrations",
          arguments: { integration: "gmail" },
        });
        expect(accounts.structuredContent).toMatchObject({
          integration: "google_gmail",
          total: 1,
          items: [{ integration: "google_gmail" }],
        });
        const both = await client.callTool({
          name: "integrations",
          arguments: { integration: "google" },
        });
        expect(both.structuredContent).toMatchObject({
          integrations: ["google_calendar", "google_gmail"],
          total: 2,
        });
        const none = await client.callTool({
          name: "integrations",
          arguments: { integration: "notion" },
        });
        expect(none.structuredContent).toMatchObject({ total: 0, hint: expect.any(String) });
      },
    );
  });

  it("serves four discovery and call tools even for 10000 tools", async () => {
    const { engine, executed } = makeRecordingEngine();
    const schemaReads: string[] = [];
    const lists: string[] = [];
    const catalog = Array.from({ length: 10000 }, (_, i) =>
      projection({
        integration: "bench",
        name: `record${i}`,
        description: i === 9999 ? "cobalt orchard sentinel" : `benchmark record ${i}`,
      }),
    );
    await withClient(
      {
        engine,
        mode: "passthrough",
        searchToolsEnabled: true,
        tools: toolPort(catalog, schemaReads, lists),
      },
      async (client) => {
        const listed = await client.listTools();
        expect(listed.tools.map((tool) => tool.name).sort()).toEqual([
          "integrations",
          "invoke",
          "search",
          "skills",
        ]);
        // Every byte here is paid on every turn of every client; the long
        // guide stays behind `skills`.
        expect(JSON.stringify(listed).length).toBeLessThan(3600);
        const instructions = client.getInstructions() ?? "";
        expect(instructions.length).toBeLessThan(1000);
        // The instructions name the three-call path in order, with an example.
        const order = ["integrations({})", "search({", "invoke({", "Example:"].map((marker) =>
          instructions.indexOf(marker),
        );
        expect(order.every((index) => index >= 0)).toBe(true);
        expect(order[0]).toBeLessThan(order[1]!);
        expect(order[1]).toBeLessThan(order[2]!);
        expect(lists).toEqual([]);
        expect(schemaReads).toEqual([]);
        const result = await client.callTool({
          name: "search",
          arguments: { query: "cobalt orchard sentinel" },
        });
        expect(result.structuredContent).toMatchObject({
          total: 1,
          hasMore: false,
          nextOffset: null,
          items: [{ id: "tools.bench.org.main.record9999" }],
        });
        expect(schemaReads).toEqual(["tools.bench.org.main.record9999"]);
        const found = decodeSearchItems(result.structuredContent).items[0];
        expect(found).toBeDefined();
        const invoked = await client.callTool({
          name: "invoke",
          arguments: { tool: found?.id, arguments: {} },
        });
        expect(invoked.isError ?? false).toBe(false);
        expect(executed).toEqual(['return await tools["bench.org.main.record9999"]({});']);
        const page = await client.callTool({
          name: "search",
          arguments: { query: "bench", limit: 2 },
        });
        expect(page.structuredContent).toMatchObject({
          total: 10000,
          hasMore: true,
          nextOffset: 2,
        });
        expect(decodeSearchItems(page.structuredContent).items).toHaveLength(2);
        expect(schemaReads).toHaveLength(4);
        const next = await client.callTool({
          name: "search",
          arguments: { query: "bench", limit: 2, offset: 2 },
        });
        expect(next.structuredContent).toMatchObject({ total: 10000, nextOffset: 4 });
        expect(next.structuredContent).not.toEqual(page.structuredContent);
        const missing = await client.callTool({
          name: "search",
          arguments: { query: "nonexistent quasar" },
        });
        expect(missing.structuredContent).toEqual({
          items: [],
          total: 0,
          hasMore: false,
          nextOffset: null,
        });
      },
    );
  });

  it("reads a search page's schemas in one batch and drops hits the batch hides", async () => {
    const { engine } = makeRecordingEngine();
    const schemaReads: string[] = [];
    const lists: string[] = [];
    const batches: string[][] = [];
    const catalog = Array.from({ length: 6 }, (_, i) =>
      projection({
        integration: "bench",
        name: `record${i}`,
        description: `benchmark record ${i}`,
      }),
    );
    const port = toolPort(catalog, schemaReads, lists, batches);
    const hidden = new Set<string>();
    const tools: McpToolsPort = {
      ...port,
      // A policy change between listing and the schema read hides a hit.
      schemas: (addresses, options) =>
        port
          .schemas(addresses, options)
          .pipe(
            Effect.map((views) =>
              views.map((view, index) => (hidden.has(String(addresses[index])) ? null : view)),
            ),
          ),
    };
    await withClient({ engine, mode: "passthrough", tools }, async (client) => {
      const page = await client.callTool({
        name: "search",
        arguments: { query: "benchmark record", limit: 4 },
      });
      const ids = decodeSearchItems(page.structuredContent).items.map((item) => item.id);
      expect(ids).toHaveLength(4);
      // One batch per search call, in result order; no per-hit reads outside it.
      expect(batches).toEqual([ids]);
      expect(schemaReads).toEqual(ids);

      hidden.add(ids[1]!);
      const again = await client.callTool({
        name: "search",
        arguments: { query: "benchmark record", limit: 4 },
      });
      expect(decodeSearchItems(again.structuredContent).items.map((item) => item.id)).toEqual([
        ids[0],
        ids[2],
        ids[3],
      ]);
      expect(again.structuredContent).toMatchObject({ total: 6, hasMore: true, nextOffset: 4 });
      expect(batches).toEqual([ids, ids]);
    });
  });

  it("uses current schemas and excludes static configuration tools", async () => {
    const recording = makeRecordingEngine();
    const dynamic = projection({
      integration: "notes",
      name: "create",
      inputSchema: { type: "object" },
    });
    const catalog = [dynamic, projection({ integration: "settings", name: "erase", static: true })];
    let current: ToolSchemaView = { address: dynamic.address, inputSchema: dynamic.inputSchema };
    const tools: McpToolsPort = {
      ...toolPort(catalog),
      schema: () => Effect.succeed(current),
      schemas: (addresses) => Effect.succeed(addresses.map(() => current)),
    };
    await withClient({ engine: recording.engine, mode: "passthrough", tools }, async (client) => {
      const hidden = await client.callTool({ name: "search", arguments: { query: "settings" } });
      expect(decodeSearchItems(hidden.structuredContent).items).toEqual([]);
      const staticCall = await client.callTool({
        name: "invoke",
        arguments: { tool: "tools.settings.org.main.erase", arguments: {} },
      });
      expect(staticCall.isError).toBe(true);
      await client.callTool({ name: "search", arguments: { query: "notes" } });
      current = {
        address: dynamic.address,
        inputSchema: {
          type: "object",
          properties: { title: { type: "string" } },
          required: ["title"],
        },
      };
      const invalid = await client.callTool({
        name: "invoke",
        arguments: { tool: String(dynamic.address), arguments: {} },
      });
      expect(invalid.isError).toBe(true);
      // The validation error carries the current schema so the model can
      // correct the call without another search.
      const [invalidText] = invalid.content as ReadonlyArray<{ text: string }>;
      expect(invalidText?.text).toContain("Invalid arguments");
      expect(invalidText?.text).toContain('"required":["title"]');
      expect(recording.executed).toEqual([]);
      const refreshed = await client.callTool({ name: "search", arguments: { query: "notes" } });
      expect(refreshed.structuredContent).toMatchObject({
        items: [{ arguments: "title (string, required)" }],
      });
      const full = await client.callTool({
        name: "search",
        arguments: { query: "notes", detail: "full" },
      });
      expect(full.structuredContent).toMatchObject({
        items: [{ inputSchema: { required: ["title"] } }],
      });
    });
  });

  it("returns compact hits by default: identity, one-line description, argument summary", async () => {
    const { engine } = makeRecordingEngine();
    const catalog = [
      projection({
        integration: "github",
        name: "issues.create",
        description:
          "Create an issue in a repository. Requires write access.\n\nLong second paragraph with details the model does not need to pick a tool.",
        inputSchema: {
          type: "object",
          properties: {
            title: { type: "string" },
            body: { $ref: "#/$defs/Body" },
            labels: { type: "array", items: { type: "string" } },
            state: { type: "string", enum: ["open", "closed"] },
          },
          required: ["title"],
          $defs: { Body: { type: "string" } },
        },
      }),
    ];
    await withClient({ engine, mode: "passthrough", tools: toolPort(catalog) }, async (client) => {
      const result = await client.callTool({
        name: "search",
        arguments: { query: "github issues create", limit: 1 },
      });
      expect(result.structuredContent).toEqual({
        items: [
          {
            id: "tools.github.org.main.issues.create",
            name: "issues.create",
            integration: "github",
            owner: "org",
            connection: "main",
            description: "Create an issue in a repository.",
            arguments:
              "title (string, required); body (string); labels (string[]); state (open|closed)",
          },
        ],
        total: 1,
        hasMore: false,
        nextOffset: null,
      });
      expect(JSON.stringify(result.structuredContent)).not.toContain("inputSchema");
      expect(JSON.stringify(result.structuredContent)).not.toContain("second paragraph");
    });
  });

  it("returns full schemas and account details on request and marks invoke destructive", async () => {
    const { engine } = makeRecordingEngine();
    await withClient({ engine, mode: "passthrough", tools: toolPort(CATALOG) }, async (client) => {
      const listed = await client.listTools();
      expect(listed.tools.find((tool) => tool.name === "search")?.annotations).toMatchObject({
        readOnlyHint: true,
        destructiveHint: false,
      });
      expect(listed.tools.find((tool) => tool.name === "invoke")?.annotations).toMatchObject({
        readOnlyHint: false,
        destructiveHint: true,
      });
      const result = await client.callTool({
        name: "search",
        arguments: { query: "github issues create", limit: 1, detail: "full" },
      });
      expect(result.structuredContent).toMatchObject({
        items: [
          {
            id: "tools.github.org.main.issues.create",
            owner: "org",
            connection: "main",
            annotations: { requiresApproval: true },
            inputSchema: {
              type: "object",
              properties: { title: { type: "string" }, body: { $ref: "#/$defs/Body" } },
              required: ["title"],
              $defs: { Body: { type: "string" } },
            },
          },
        ],
      });
    });
  });

  it("runs a call as one execute of single-call code, never a pause", async () => {
    const recording = makeRecordingEngine({ ok: true, data: { number: 7 } });
    await withClient(
      {
        engine: recording.engine,
        mode: "passthrough",
        tools: toolPort(CATALOG),
      },
      async (client) => {
        const result = await client.callTool({
          name: "invoke",
          arguments: { tool: "tools.github.org.main.issues.create", arguments: { title: "hello" } },
        });
        expect(recording.executed).toEqual([
          'return await tools["github.org.main.issues.create"]({"title":"hello"});',
        ]);
        expect(recording.pausedCalls()).toBe(0);
        // The tool's `data` is the result: nothing sits between the tool and
        // the client to unwrap the `{ ok, data }` envelope for it.
        expect(result.isError ?? false).toBe(false);
        expect(result.structuredContent).toEqual({
          status: "completed",
          result: { number: 7 },
          logs: [],
        });
      },
    );
  });

  it("surfaces an expected tool failure as an MCP error result", async () => {
    const recording = makeRecordingEngine({
      ok: false,
      error: { code: "tool_blocked", message: "Tool blocked by policy: github.org.main.x" },
    });
    await withClient(
      {
        engine: recording.engine,
        mode: "passthrough",
        tools: toolPort(CATALOG),
      },
      async (client) => {
        const result = await client.callTool({
          name: "invoke",
          arguments: { tool: "tools.github.org.main.issues.list", arguments: {} },
        });
        expect(result.isError).toBe(true);
        expect(result.structuredContent).toEqual({
          status: "error",
          error: { code: "tool_blocked", message: "Tool blocked by policy: github.org.main.x" },
          logs: [],
        });
        const text = (result.content as Array<{ type: string; text?: string }>)[0]?.text ?? "";
        expect(text).toContain("tool_blocked");
      },
    );
  });

  /** An engine whose tool raises the given elicitations in order and records
   *  each answer. `source` is what the executor stamps: `policy` for its own
   *  approval gate, `tool` for anything the tool asked for itself. */
  const elicitingEngine = (
    requests: ReadonlyArray<{ readonly source: "policy" | "tool"; readonly request: any }>,
    seen: string[],
  ): ExecutionEngine => ({
    ...makeRecordingEngine().engine,
    execute: (_code, options) =>
      Effect.gen(function* () {
        for (const { source, request } of requests) {
          const answer = yield* options.onElicitation({
            address: CATALOG[0]!.address,
            args: {},
            request,
            source,
          });
          seen.push(`${source}:${answer.action}`);
          if (answer.action !== "accept") {
            return { result: { ok: false, error: { code: "declined", message: "declined" } } };
          }
        }
        return { result: { ok: true, data: null } };
      }),
  });

  const approvalGate = {
    _tag: "FormElicitation" as const,
    message: "Approve github.org.main.issues.create?",
    requestedSchema: { type: "object", properties: {} },
  };

  it("accepts the executor's own approval gate inline", async () => {
    const seen: string[] = [];
    await withClient(
      {
        engine: elicitingEngine([{ source: "policy", request: approvalGate }], seen),
        mode: "passthrough",
        tools: toolPort(CATALOG),
      },
      async (client) => {
        const result = await client.callTool({
          name: "invoke",
          arguments: { tool: "tools.github.org.main.issues.create", arguments: { title: "x" } },
        });
        expect(seen).toEqual(["policy:accept"]);
        expect(result.isError ?? false).toBe(false);
      },
    );
  });

  it("keeps every invoke marked destructive even when the selected tool has no approval annotation", async () => {
    const seen: string[] = [];
    await withClient(
      {
        engine: elicitingEngine([{ source: "policy", request: approvalGate }], seen),
        mode: "passthrough",
        tools: toolPort(CATALOG),
      },
      async (client) => {
        const invoke = (await client.listTools()).tools.find((tool) => tool.name === "invoke");
        expect(invoke?.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: true });
        const result = await client.callTool({
          name: "invoke",
          arguments: { tool: "tools.github.org.main.issues.list", arguments: {} },
        });
        expect(seen).toEqual(["policy:accept"]);
        expect(result.isError ?? false).toBe(false);
      },
    );
  });

  it("never auto-accepts a tool-raised prompt, even one with an empty schema", async () => {
    // Same wire shape as the approval gate, but raised by the TOOL: a
    // per-site grant whose terms live in `meta`. Provenance, not shape,
    // decides. With no elicitation capability on the client, the call fails
    // and says so — it is not silently granted.
    const seen: string[] = [];
    const siteGrant = {
      _tag: "FormElicitation" as const,
      message: "Allow Browser use to access example.com?",
      requestedSchema: {},
      meta: { persist: "always", origin: "https://example.com" },
    };
    await withClient(
      {
        engine: elicitingEngine([{ source: "tool", request: siteGrant }], seen),
        mode: "passthrough",
        tools: toolPort(CATALOG),
      },
      async (client) => {
        const result = await client.callTool({
          name: "invoke",
          arguments: { tool: "tools.github.org.main.issues.create", arguments: { title: "x" } },
        });
        expect(seen).toEqual(["tool:decline"]);
        expect(result.isError).toBe(true);
        expect(result.structuredContent).toMatchObject({
          status: "error",
          error: { code: "elicitation_unsupported", request: siteGrant.message },
        });
      },
    );
  });

  it("reports an unanswerable URL request with the URL, not as a user decline", async () => {
    const seen: string[] = [];
    const reconnect = {
      _tag: "UrlElicitation" as const,
      message: "Reconnect GitHub",
      url: "https://example.test/oauth/start",
      elicitationId: "elic_1",
    };
    await withClient(
      {
        engine: elicitingEngine([{ source: "tool", request: reconnect }], seen),
        mode: "passthrough",
        tools: toolPort(CATALOG),
      },
      async (client) => {
        const result = await client.callTool({
          name: "invoke",
          arguments: { tool: "tools.github.org.main.issues.create", arguments: { title: "x" } },
        });
        expect(seen).toEqual(["tool:decline"]);
        expect(result.isError).toBe(true);
        const text = (result.content as Array<{ text?: string }>)[0]?.text ?? "";
        expect(text).toContain("does not support elicitation");
        expect(text).toContain("https://example.test/oauth/start");
        expect(text).not.toContain("declined by the user");
        expect(result.structuredContent).toMatchObject({
          error: { code: "elicitation_unsupported", url: reconnect.url },
        });
      },
    );
  });

  it.each([true, false])(
    "honors artifacts=%s independently of passthrough",
    async (artifactsEnabled) => {
      const { engine } = makeRecordingEngine();
      await withClient(
        {
          engine,
          mode: "passthrough",
          artifactsEnabled,
          loadAppShellHtml: async () => "<html></html>",
          artifacts: {
            list: () => Effect.succeed([]),
            get: () => Effect.die("unused"),
            save: () => Effect.die("unused"),
          },
          tools: toolPort(CATALOG),
        },
        async (client) => {
          const names = (await client.listTools()).tools.map((tool) => tool.name);
          expect(names).toEqual(
            expect.arrayContaining(["integrations", "invoke", "search", "skills"]),
          );
          expect(names).not.toContain("execute");
          expect(names).not.toContain("resume");
          for (const name of [
            "create-artifact",
            "edit-artifact",
            "list-artifacts",
            "show-artifact",
          ]) {
            expect(names.includes(name)).toBe(artifactsEnabled);
          }
          const guide = await client.callTool({
            name: "skills",
            arguments: { name: "create-artifact" },
          });
          expect(guide.isError === true).toBe(!artifactsEnabled);
          expect(JSON.stringify(guide.content).includes("queryOptions")).toBe(artifactsEnabled);
          expect(JSON.stringify(guide.content)).not.toContain("`execute`");
        },
      );
    },
  );

  it("rejects arguments that fail the advertised schema before running anything", async () => {
    const recording = makeRecordingEngine();
    await withClient(
      {
        engine: recording.engine,
        mode: "passthrough",
        tools: toolPort(CATALOG),
      },
      async (client) => {
        const result = await client.callTool({
          name: "invoke",
          arguments: {
            tool: "tools.github.org.main.issues.create",
            arguments: { body: "no title" },
          },
        });
        expect(result.isError).toBe(true);
        expect(JSON.stringify(result.content)).toContain("Invalid arguments");
        expect(recording.executed).toEqual([]);
      },
    );
  });

  it("answers an unknown tool name with a not-found error", async () => {
    const { engine } = makeRecordingEngine();
    await withClient(
      {
        engine,
        mode: "passthrough",
        tools: toolPort(CATALOG),
      },
      async (client) => {
        const result = await client.callTool({
          name: "invoke",
          arguments: { tool: "tools.github.org.main.nope", arguments: {} },
        });
        expect(result.isError).toBe(true);
        expect(JSON.stringify(result.content)).toContain("not found");
      },
    );
  });

  it("rejects empty searches, oversized pages and malformed invoke inputs", async () => {
    const recording = makeRecordingEngine();
    await withClient(
      {
        engine: recording.engine,
        mode: "passthrough",
        tools: toolPort(CATALOG),
      },
      async (client) => {
        for (const arguments_ of [
          { query: " " },
          { query: "github", limit: 21 },
          { query: "github", offset: -1 },
        ]) {
          expect((await client.callTool({ name: "search", arguments: arguments_ })).isError).toBe(
            true,
          );
        }
        expect(
          (
            await client.callTool({
              name: "invoke",
              arguments: { tool: "tools.github.org.main.issues.create", arguments: "{}" },
            })
          ).isError,
        ).toBe(true);
        expect(recording.executed).toEqual([]);
      },
    );
  });

  it("leaves codemode untouched when the mode is absent", async () => {
    const { engine } = makeRecordingEngine();
    await withClient(
      {
        engine,
        description: "Execute TypeScript in a sandboxed runtime.",
        tools: toolPort(CATALOG),
      },
      async (client) => {
        const names = (await client.listTools()).tools.map((tool) => tool.name);
        expect(names).toContain("execute");
        expect(names).toContain("skills");
        expect(names).not.toContain("github__issues_create");
      },
    );
  });

  it("fails the build, not the session, when the host provides no catalog", async () => {
    const { engine } = makeRecordingEngine();
    const outcome = await Effect.runPromise(
      createExecutorMcpServer({ engine, mode: "passthrough" }).pipe(Effect.flip),
    );
    expect(outcome).toBeInstanceOf(McpPassthroughUnavailableError);
  });
});
