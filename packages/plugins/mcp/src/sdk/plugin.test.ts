import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";

import {
  AuthTemplateSlug,
  ConnectionName,
  IntegrationSlug,
  ToolAddress,
  createExecutor,
} from "@executor-js/sdk";
import { makeTestConfig, memoryCredentialsPlugin } from "@executor-js/sdk/testing";

import { mcpPlugin, userFacingProbeMessage } from "./plugin";
import { extractManifestFromListToolsResult, deriveMcpNamespace, joinToolPath } from "./manifest";
import { makeAnnotationsMcpServer, serveMcpServer } from "../testing";

// removed: the v1 addSource / scopes / secrets / credential-binding / usages /
// sources.configure / multi-scope shadowing suites. v2 has no scope stack, no
// secrets table, and no credential bindings — an MCP server is registered as an
// integration (`addServer`) and a connection IS the credential (created via
// `connections.create` / `oauth.start`). Owner isolation is covered by
// owner-isolation.test.ts; the end-to-end auth/header path is covered by
// elicitation.test.ts + owner-isolation.test.ts.

const TEMPLATE = AuthTemplateSlug.make("none");

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
      expect(executor.mcp.addServer).toBeTypeOf("function");
      expect(executor.mcp.removeServer).toBeTypeOf("function");
      expect(executor.mcp.getServer).toBeTypeOf("function");
      expect(executor.mcp.probeEndpoint).toBeTypeOf("function");
      expect(executor.oauth.start).toBeTypeOf("function");
      expect(executor.oauth.complete).toBeTypeOf("function");
    }),
  );

  it.effect("integration catalog has no configured MCP integrations initially", () =>
    Effect.gen(function* () {
      const executor = yield* createExecutor(makeTestConfig({ plugins: [mcpPlugin()] as const }));
      const integrations = yield* executor.integrations.list();
      expect(integrations.filter((i) => i.kind === "mcp")).toHaveLength(0);
    }),
  );

  it.effect("connection tools list is empty until a connection is created", () =>
    Effect.gen(function* () {
      const executor = yield* createExecutor(makeTestConfig({ plugins: [mcpPlugin()] as const }));
      const tools = yield* executor.tools.list();
      expect(tools.filter((tool) => String(tool.address).startsWith("tools."))).toHaveLength(0);
    }),
  );

  // When discovery fails (auth, network, etc.) the connection still lands with
  // an empty tool set so the user can retry via `connections.refresh` once they
  // fix the underlying problem.
  it.effect("registers integration + connection with 0 tools when discovery fails", () =>
    Effect.gen(function* () {
      const executor = yield* createExecutor(
        makeTestConfig({ plugins: [memoryCredentialsPlugin(), mcpPlugin()] as const }),
      );

      const slugStr = "broken_source";
      yield* executor.mcp.addServer({
        name: "broken",
        // Port 1 is reserved — connection-refused immediately, giving a
        // deterministic discovery failure without any server mocks.
        endpoint: "http://127.0.0.1:1/mcp",
        slug: slugStr,
      });
      const connection = yield* executor.connections.create({
        owner: "org",
        name: ConnectionName.make("main"),
        integration: IntegrationSlug.make(slugStr),
        template: TEMPLATE,
        value: "",
      });
      expect(String(connection.address)).toBe("tools.broken_source.org.main");

      const integration = yield* executor.integrations.get(IntegrationSlug.make(slugStr));
      expect(integration?.kind).toBe("mcp");

      const tools = yield* executor.tools.list();
      expect(tools.filter((t) => String(t.integration) === slugStr)).toHaveLength(0);
    }),
  );

  it.effect("static probeEndpoint returns actionable tool failures", () =>
    Effect.gen(function* () {
      const config = makeTestConfig({ plugins: [mcpPlugin()] as const });
      const executor = yield* createExecutor(config);

      const result = yield* executor.execute(ToolAddress.make("executor.mcp.probeEndpoint"), {
        endpoint: "http://127.0.0.1:1/mcp",
      });

      expect(result).toMatchObject({
        ok: false,
        error: {
          code: "mcp_connection_failed",
        },
      });

      yield* executor.close();
      yield* Effect.promise(() => config.testDb.close());
    }),
  );
});

// ---------------------------------------------------------------------------
// destructiveHint → requiresApproval (end-to-end with a real local server)
// ---------------------------------------------------------------------------

const serveAnnotationsTestServer = serveMcpServer(makeAnnotationsMcpServer);

const seedAnnotationsExecutor = (serverUrl: string) =>
  createExecutor(
    makeTestConfig({ plugins: [memoryCredentialsPlugin(), mcpPlugin()] as const }),
  ).pipe(
    Effect.tap((executor) =>
      Effect.gen(function* () {
        yield* executor.mcp.addServer({
          name: "annotations-test",
          endpoint: serverUrl,
          slug: "annotations_test",
        });
        yield* executor.connections.create({
          owner: "org",
          name: ConnectionName.make("main"),
          integration: IntegrationSlug.make("annotations_test"),
          template: TEMPLATE,
          value: "",
        });
      }),
    ),
  );

describe("MCP destructiveHint → requiresApproval", () => {
  it.effect("destructiveHint becomes requiresApproval, others stay false", () =>
    Effect.gen(function* () {
      const server = yield* serveAnnotationsTestServer;
      const executor = yield* seedAnnotationsExecutor(server.url);

      const tools = yield* executor.tools.list();

      const deleteTool = tools.find((t) => String(t.name) === "delete");
      expect(deleteTool?.annotations?.requiresApproval).toBe(true);

      const listTool = tools.find((t) => String(t.name) === "list");
      expect(listTool?.annotations?.requiresApproval).toBeFalsy();

      const pingTool = tools.find((t) => String(t.name) === "ping");
      expect(pingTool?.annotations?.requiresApproval).toBeFalsy();
    }),
  );

  it.effect("uses annotations.title as approvalDescription when present", () =>
    Effect.gen(function* () {
      const server = yield* serveAnnotationsTestServer;
      const executor = yield* seedAnnotationsExecutor(server.url);

      const tools = yield* executor.tools.list();
      const deleteTitled = tools.find((t) => String(t.name) === "delete_titled");
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
  // Port 1 connection-refuses immediately, so wire-shape detection returns
  // `unreachable` and the URL-token fallback is the only thing that can produce
  // a candidate.
  it.effect("returns low-confidence candidate when path has /mcp segment", () =>
    Effect.gen(function* () {
      const executor = yield* createExecutor(makeTestConfig({ plugins: [mcpPlugin()] as const }));
      const results = yield* executor.integrations.detect("http://127.0.0.1:1/api/mcp");
      const mcp = results.find((r) => r.kind === "mcp");
      expect(mcp).toBeDefined();
      expect(mcp?.confidence).toBe("low");
    }),
  );

  it.effect("matches mcp on hostname label", () =>
    Effect.gen(function* () {
      const executor = yield* createExecutor(makeTestConfig({ plugins: [mcpPlugin()] as const }));
      const results = yield* executor.integrations.detect("http://mcp.127.0.0.1.nip.io:1/");
      const mcp = results.find((r) => r.kind === "mcp");
      expect(mcp?.confidence).toBe("low");
    }),
  );

  it.effect("does not match mcp as a substring", () =>
    Effect.gen(function* () {
      const executor = yield* createExecutor(makeTestConfig({ plugins: [mcpPlugin()] as const }));
      // `/mcpstore` contains `mcp` but it is not a separator-bounded run, so
      // the URL-token fallback must not fire.
      const results = yield* executor.integrations.detect("http://127.0.0.1:1/mcpstore");
      expect(results.find((r) => r.kind === "mcp")).toBeUndefined();
    }),
  );

  it.effect("returns null when no token match and no wire-shape match", () =>
    Effect.gen(function* () {
      const executor = yield* createExecutor(makeTestConfig({ plugins: [mcpPlugin()] as const }));
      const results = yield* executor.integrations.detect("http://127.0.0.1:1/api/v1");
      expect(results.find((r) => r.kind === "mcp")).toBeUndefined();
    }),
  );
});
