import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type * as Cause from "effect/Cause";

import type { ExecutionEngine } from "@executor-js/execution";
import { ToolAddress, type ToolProjection } from "@executor-js/sdk";

import { readPassthroughIntegrations, readToolMode } from "./browser-approval";
import {
  MAX_TOOL_NAME_LENGTH,
  assignPassthroughNames,
  passthroughAnnotations,
  passthroughCallCode,
  preferredToolName,
} from "./passthrough-tools";
import {
  createExecutorMcpServer,
  McpPassthroughUnavailableError,
  type ExecutorMcpServerConfig,
} from "./tool-server";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const projection = (
  input: Partial<ToolProjection> & { readonly integration: string; readonly name: string },
): ToolProjection => {
  const owner = input.owner ?? "org";
  const connection = input.connection ?? "main";
  return {
    address: ToolAddress.make(`tools.${input.integration}.${owner}.${connection}.${input.name}`),
    integration: input.integration,
    owner,
    connection,
    name: input.name,
    description: input.description ?? `${input.integration} ${input.name}`,
    policy: input.policy ?? "approve",
    ...(input.inputSchema === undefined ? {} : { inputSchema: input.inputSchema }),
    ...(input.readOnly === undefined ? {} : { readOnly: input.readOnly }),
  };
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
  const mcpServer = await Effect.runPromise(createExecutorMcpServer(config));
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

const CATALOG: readonly ToolProjection[] = [
  projection({
    integration: "github",
    name: "issues.create",
    policy: "require_approval",
    readOnly: false,
    inputSchema: {
      type: "object",
      properties: { title: { type: "string" }, body: { $ref: "#/$defs/Body" } },
      required: ["title"],
      $defs: { Body: { type: "string" } },
    },
  }),
  projection({ integration: "github", name: "issues.list", readOnly: true }),
  projection({ integration: "linear", name: "issueCreate", policy: "require_approval" }),
];

// ---------------------------------------------------------------------------
// Pure: naming
// ---------------------------------------------------------------------------

describe("passthrough naming", () => {
  it("joins integration and tool with a double underscore and flattens dots", () => {
    expect(
      preferredToolName(
        { integration: "github", connection: "main", name: "issues.create" },
        false,
      ),
    ).toBe("github__issues_create");
  });

  it("spells the connection out only when an integration has several", () => {
    const named = assignPassthroughNames([
      projection({ integration: "vercel", connection: "personal", name: "domains.list" }),
      projection({ integration: "vercel", connection: "work", name: "domains.list" }),
      projection({ integration: "linear", name: "issueCreate" }),
    ]);
    expect(named.map((tool) => tool.name).sort()).toEqual([
      "linear__issueCreate",
      "vercel__personal__domains_list",
      "vercel__work__domains_list",
    ]);
  });

  it("treats the same connection name under two owners as two connections", () => {
    const named = assignPassthroughNames([
      projection({ integration: "slack", owner: "org", connection: "main", name: "post" }),
      projection({ integration: "slack", owner: "user", connection: "main", name: "post" }),
    ]);
    // Both are `main`, so the connection segment alone would collide; the
    // hash suffix keeps them apart rather than dropping one.
    expect(new Set(named.map((tool) => tool.name)).size).toBe(2);
    for (const tool of named) expect(tool.name.startsWith("slack__main__post")).toBe(true);
  });

  it("caps names at the provider limit with a stable hash suffix", () => {
    const long = "a".repeat(80);
    const [tool] = assignPassthroughNames([projection({ integration: "svc", name: long })]);
    expect(tool!.name.length).toBeLessThanOrEqual(MAX_TOOL_NAME_LENGTH);
    expect(tool!.name).toMatch(/^svc__a+-[0-9a-f]{7}$/);
    // Stable across runs: the suffix is a function of the address.
    const [again] = assignPassthroughNames([projection({ integration: "svc", name: long })]);
    expect(again!.name).toBe(tool!.name);
  });

  it("keeps two long names that share a prefix distinct", () => {
    const base = "operation_".repeat(8);
    const named = assignPassthroughNames([
      projection({ integration: "svc", name: `${base}one` }),
      projection({ integration: "svc", name: `${base}two` }),
    ]);
    expect(new Set(named.map((tool) => tool.name)).size).toBe(2);
  });

  it("is deterministic regardless of input order", () => {
    const a = assignPassthroughNames(CATALOG).map((tool) => tool.name);
    const b = assignPassthroughNames([...CATALOG].reverse()).map((tool) => tool.name);
    expect(a).toEqual(b);
  });

  it("replaces every character outside the MCP grammar", () => {
    const [tool] = assignPassthroughNames([
      projection({ integration: "my api", name: "get:thing/by id" }),
    ]);
    expect(tool!.name).toMatch(/^[A-Za-z0-9_-]+$/);
  });
});

// ---------------------------------------------------------------------------
// Pure: annotations + code
// ---------------------------------------------------------------------------

describe("passthrough annotations", () => {
  it("maps require_approval to destructiveHint and sets both hints explicitly", () => {
    expect(passthroughAnnotations({ name: "x", policy: "require_approval" })).toEqual({
      title: "x",
      readOnlyHint: false,
      destructiveHint: true,
      openWorldHint: true,
    });
    expect(passthroughAnnotations({ name: "x", policy: "approve", readOnly: true })).toEqual({
      title: "x",
      readOnlyHint: true,
      destructiveHint: false,
      openWorldHint: true,
    });
  });

  it("never advertises read-only for a tool no plugin vouched for", () => {
    expect(passthroughAnnotations({ name: "x", policy: "approve" }).readOnlyHint).toBe(false);
  });

  it("emits exactly one awaited tool call with every segment as a string literal", () => {
    expect(passthroughCallCode("tools.github.org.main.issues.create", { title: "hi" })).toBe(
      'return await tools["github"]["org"]["main"]["issues"]["create"]({"title":"hi"});',
    );
    expect(passthroughCallCode("linear.org.main.issueCreate", undefined)).toBe(
      'return await tools["linear"]["org"]["main"]["issueCreate"]({});',
    );
  });

  it("keeps a hostile tool segment as data, never as code", () => {
    // An OpenAPI spec controls its tool paths (`x-executor-toolPath`), so a
    // segment can contain anything. It must land inside a JSON string.
    const hostile = "x(await tools.victim.org.main.destroy({}))";
    const code = passthroughCallCode(`tools.evil.org.main.${hostile}`, {});
    expect(code).toBe(
      `return await tools["evil"]["org"]["main"]["x(await tools"]["victim"]["org"]["main"]["destroy({}))"]({});`,
    );
    // Structural proof the payload never escapes a string literal: the source
    // is exactly `return await tools` + N bracket-quoted segments + one call.
    // Every quoted segment round-trips through JSON.parse to the raw text, so
    // whatever the segment contains is data to the interpreter.
    const shape = /^return await tools((?:\["(?:[^"\\]|\\.)*"\])+)\((\{.*\})\);$/s.exec(code);
    expect(shape).not.toBeNull();
    const segments = [...shape![1]!.matchAll(/\["((?:[^"\\]|\\.)*)"\]/g)].map((m) =>
      JSON.parse(`"${m[1]}"`),
    );
    expect(segments).toEqual([
      "evil",
      "org",
      "main",
      "x(await tools",
      "victim",
      "org",
      "main",
      "destroy({}))",
    ]);
  });
});

// ---------------------------------------------------------------------------
// Wire flags
// ---------------------------------------------------------------------------

describe("readToolMode / readPassthroughIntegrations", () => {
  const request = (query: string) => new Request(`https://example.test/mcp${query}`);

  it("defaults to codemode and only accepts the exact passthrough spelling", () => {
    expect(readToolMode(request(""))).toBe("codemode");
    expect(readToolMode(request("?mode=passthrough"))).toBe("passthrough");
    expect(readToolMode(request("?mode=Passthrough"))).toBe("codemode");
    expect(readToolMode(request("?mode=direct"))).toBe("codemode");
  });

  it("parses, trims and de-duplicates the integration filter", () => {
    expect(readPassthroughIntegrations(request(""))).toBeUndefined();
    expect(readPassthroughIntegrations(request("?integrations="))).toBeUndefined();
    expect(readPassthroughIntegrations(request("?integrations=github,%20linear,github,"))).toEqual([
      "github",
      "linear",
    ]);
  });
});

// ---------------------------------------------------------------------------
// Server: the served surface
// ---------------------------------------------------------------------------

describe("passthrough mode server", () => {
  it("serves the catalog and none of the codemode tools", async () => {
    const { engine } = makeRecordingEngine();
    await withClient(
      {
        engine,
        mode: "passthrough",
        searchToolsEnabled: true,
        tools: { describeAll: () => Effect.succeed(CATALOG) },
      },
      async (client) => {
        const listed = await client.listTools();
        const names = listed.tools.map((tool) => tool.name).sort();
        expect(names).toEqual([
          "github__issues_create",
          "github__issues_list",
          "linear__issueCreate",
        ]);
        // The fixed surface is gone — including the opt-in search tools.
        expect(names).not.toContain("execute");
        expect(names).not.toContain("skills");
        expect(names).not.toContain("resume");
        expect(names.some((name) => name.startsWith("search_"))).toBe(false);
      },
    );
  });

  it("advertises policy as annotations and the stored JSON Schema verbatim", async () => {
    const { engine } = makeRecordingEngine();
    await withClient(
      {
        engine,
        mode: "passthrough",
        tools: { describeAll: () => Effect.succeed(CATALOG) },
      },
      async (client) => {
        const listed = await client.listTools();
        const create = listed.tools.find((tool) => tool.name === "github__issues_create");
        expect(create?.annotations).toEqual({
          title: "issues.create",
          readOnlyHint: false,
          destructiveHint: true,
          openWorldHint: true,
        });
        expect(create?.inputSchema).toEqual({
          type: "object",
          properties: { title: { type: "string" }, body: { $ref: "#/$defs/Body" } },
          required: ["title"],
          $defs: { Body: { type: "string" } },
        });
        const list = listed.tools.find((tool) => tool.name === "github__issues_list");
        expect(list?.annotations).toEqual({
          title: "issues.list",
          readOnlyHint: true,
          destructiveHint: false,
          openWorldHint: true,
        });
        // No declared input → the permissive empty object, so `{}` is callable.
        expect(list?.inputSchema).toEqual({ type: "object", properties: {} });
      },
    );
  });

  it("runs a call as one execute of single-call code, never a pause", async () => {
    const recording = makeRecordingEngine({ ok: true, data: { number: 7 } });
    await withClient(
      {
        engine: recording.engine,
        mode: "passthrough",
        tools: { describeAll: () => Effect.succeed(CATALOG) },
      },
      async (client) => {
        const result = await client.callTool({
          name: "github__issues_create",
          arguments: { title: "hello" },
        });
        expect(recording.executed).toEqual([
          'return await tools["github"]["org"]["main"]["issues"]["create"]({"title":"hello"});',
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
        tools: { describeAll: () => Effect.succeed(CATALOG) },
      },
      async (client) => {
        const result = await client.callTool({ name: "github__issues_list", arguments: {} });
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
        tools: { describeAll: () => Effect.succeed(CATALOG) },
      },
      async (client) => {
        const result = await client.callTool({
          name: "github__issues_create",
          arguments: { title: "x" },
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
        tools: { describeAll: () => Effect.succeed(CATALOG) },
      },
      async (client) => {
        const result = await client.callTool({
          name: "github__issues_create",
          arguments: { title: "x" },
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
        tools: { describeAll: () => Effect.succeed(CATALOG) },
      },
      async (client) => {
        const result = await client.callTool({
          name: "github__issues_create",
          arguments: { title: "x" },
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

  it("serves no artifact tools in passthrough even when artifacts are requested", async () => {
    const { engine } = makeRecordingEngine();
    await withClient(
      {
        engine,
        mode: "passthrough",
        artifactsEnabled: true,
        loadAppShellHtml: async () => "<html></html>",
        artifacts: {
          list: () => Effect.succeed([]),
          get: () => Effect.die("unused"),
          save: () => Effect.die("unused"),
        },
        tools: { describeAll: () => Effect.succeed(CATALOG) },
      },
      async (client) => {
        const names = (await client.listTools()).tools.map((tool) => tool.name);
        expect(names.sort()).toEqual([
          "github__issues_create",
          "github__issues_list",
          "linear__issueCreate",
        ]);
      },
    );
  });

  it("rejects arguments that fail the advertised schema before running anything", async () => {
    const recording = makeRecordingEngine();
    await withClient(
      {
        engine: recording.engine,
        mode: "passthrough",
        tools: { describeAll: () => Effect.succeed(CATALOG) },
      },
      async (client) => {
        await expect(
          client.callTool({ name: "github__issues_create", arguments: { body: "no title" } }),
        ).rejects.toThrow(/Invalid arguments for tool github__issues_create/);
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
        tools: { describeAll: () => Effect.succeed(CATALOG) },
      },
      async (client) => {
        await expect(client.callTool({ name: "github__nope", arguments: {} })).rejects.toThrow(
          /not found/,
        );
      },
    );
  });

  it("narrows to the requested integrations and says which were not connected", async () => {
    const { engine } = makeRecordingEngine();
    await withClient(
      {
        engine,
        mode: "passthrough",
        passthroughIntegrations: ["linear", "notion"],
        tools: { describeAll: () => Effect.succeed(CATALOG) },
      },
      async (client) => {
        const listed = await client.listTools();
        expect(listed.tools.map((tool) => tool.name)).toEqual(["linear__issueCreate"]);
        const instructions = client.getInstructions() ?? "";
        expect(instructions).toContain("1 integration tool");
        expect(instructions).toContain("Requested but not connected (no tools served): notion");
      },
    );
  });

  it("leaves codemode untouched when the mode is absent", async () => {
    const { engine } = makeRecordingEngine();
    await withClient(
      {
        engine,
        description: "Execute TypeScript in a sandboxed runtime.",
        tools: { describeAll: () => Effect.succeed(CATALOG) },
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
