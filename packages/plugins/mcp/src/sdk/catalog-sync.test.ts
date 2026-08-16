// ---------------------------------------------------------------------------
// MCP tool-catalog freshness (end-to-end).
//
// The persisted per-connection tool catalog must converge with the server's
// live tool set. Spec inputs the executor reacts to:
//   - `notifications/tools/list_changed` received during a call window marks
//     the connection stale; the next tools read re-lists.
//   - An unknown-tool protocol error (`-32602`, "Tool … not found") on
//     `tools/call` means the catalog drifted: the call fails with a typed
//     `mcp_tool_unknown` ToolResult and the catalog heals on the next read.
//   - `tools/list` is paginated; discovery follows `nextCursor` to the end.
//   - A failed listing (server unreachable) is non-authoritative: the
//     previously persisted catalog is kept, not wiped.
// ---------------------------------------------------------------------------

import { describe, expect, it } from "@effect/vitest";
import { Effect, Option, Schema } from "effect";
import { HttpServerResponse } from "effect/unstable/http";

import {
  AuthTemplateSlug,
  ConnectionName,
  IntegrationSlug,
  ToolAddress,
  createExecutor,
} from "@executor-js/sdk";
import {
  makeTestConfig,
  memoryCredentialsPlugin,
  serveTestHttpApp,
} from "@executor-js/sdk/testing";

import { mcpPlugin } from "./plugin";
import { createMcpConnector } from "./connection";
import { discoverTools } from "./discover";
import { makeMutableCatalogMcpServer, serveMcpServer } from "../testing";

const INTEG = IntegrationSlug.make("catalog_mcp");
const CONNECTION = ConnectionName.make("main");
const TEMPLATE = AuthTemplateSlug.make("none");

const makeCatalogTestExecutor = (
  serverUrl: string,
  options?: { readonly toolsSyncTtlMs?: number | null },
) =>
  createExecutor({
    ...makeTestConfig({ plugins: [memoryCredentialsPlugin(), mcpPlugin()] as const }),
    ...(options?.toolsSyncTtlMs === undefined ? {} : { toolsSyncTtlMs: options.toolsSyncTtlMs }),
  }).pipe(
    Effect.tap((executor) =>
      Effect.gen(function* () {
        yield* executor.mcp.addServer({
          name: "catalog-mcp",
          endpoint: serverUrl,
          slug: String(INTEG),
        });
        yield* executor.connections.create({
          owner: "org",
          name: CONNECTION,
          integration: INTEG,
          template: TEMPLATE,
          value: "",
        });
      }),
    ),
  );

const toolNames = (tools: readonly { readonly name: unknown }[]): readonly string[] =>
  tools.map((tool) => String(tool.name)).sort();

describe("MCP tool-catalog sync (end-to-end)", () => {
  it.effect(
    "tools/list_changed during a call marks the catalog stale and the next read re-lists",
    () =>
      Effect.gen(function* () {
        const mutable = makeMutableCatalogMcpServer();
        const server = yield* serveMcpServer(mutable.factory);
        const executor = yield* makeCatalogTestExecutor(server.url);

        expect(toolNames(yield* executor.tools.list())).toContain(mutable.initialToolName);

        // `rename_greet` renames the greet tool mid-call; the SDK server sends
        // `notifications/tools/list_changed` on the open connection, which the
        // invoke path records and turns into a stale mark after the call.
        const result = yield* executor.execute(
          ToolAddress.make(`tools.${String(INTEG)}.org.main.rename_greet`),
          {},
        );
        expect(result).toMatchObject({ ok: true });

        // No manual refresh: the next tools read re-lists from the server.
        const refreshed = toolNames(yield* executor.tools.list());
        expect(refreshed).toContain(mutable.renamedToolName);
        expect(refreshed).not.toContain(mutable.initialToolName);
      }),
  );

  it.effect(
    "unknown-tool rejection fails typed, marks stale, and the catalog heals on the next read",
    () =>
      Effect.gen(function* () {
        const mutable = makeMutableCatalogMcpServer();
        const server = yield* serveMcpServer(mutable.factory);
        // TTL disabled: only the unknown-tool signal may trigger the re-list.
        const executor = yield* makeCatalogTestExecutor(server.url, { toolsSyncTtlMs: null });

        expect(toolNames(yield* executor.tools.list())).toContain(mutable.initialToolName);

        // Mutate the server catalog outside any executor call window — the
        // executor has no notification to react to and its catalog is drifted.
        mutable.renameTool();

        const staleAddress = ToolAddress.make(
          `tools.${String(INTEG)}.org.main.${mutable.initialToolName}`,
        );
        const result = yield* executor.execute(staleAddress, { name: "world" });
        expect(result).toMatchObject({
          ok: false,
          error: { code: "mcp_tool_unknown" },
        });

        // The failure marked the connection stale; the next read converges.
        const healed = toolNames(yield* executor.tools.list());
        expect(healed).toContain(mutable.renamedToolName);
        expect(healed).not.toContain(mutable.initialToolName);
      }),
  );

  it.effect("expired catalogs re-list on read once older than the freshness TTL", () =>
    Effect.gen(function* () {
      const mutable = makeMutableCatalogMcpServer();
      const server = yield* serveMcpServer(mutable.factory);
      // Everything is instantly stale — every tools read re-lists.
      const executor = yield* makeCatalogTestExecutor(server.url, { toolsSyncTtlMs: 0 });

      expect(toolNames(yield* executor.tools.list())).toContain(mutable.initialToolName);

      // Server-side change with no notification and no executor signal at all.
      mutable.renameTool();

      const refreshed = toolNames(yield* executor.tools.list());
      expect(refreshed).toContain(mutable.renamedToolName);
      expect(refreshed).not.toContain(mutable.initialToolName);
    }),
  );

  it.effect("a fresh catalog inside the TTL is served from the persisted rows", () =>
    Effect.gen(function* () {
      const mutable = makeMutableCatalogMcpServer();
      const server = yield* serveMcpServer(mutable.factory);
      const executor = yield* makeCatalogTestExecutor(server.url, {
        toolsSyncTtlMs: 60 * 60 * 1000,
      });

      expect(toolNames(yield* executor.tools.list())).toContain(mutable.initialToolName);
      const sessionsAfterFirstList = server.sessionCount();

      mutable.renameTool();

      // Within the TTL and with no stale signal, reads serve the persisted
      // catalog without dialing the server.
      expect(toolNames(yield* executor.tools.list())).toContain(mutable.initialToolName);
      expect(server.sessionCount()).toBe(sessionsAfterFirstList);
    }),
  );
});

// ---------------------------------------------------------------------------
// Pagination — discovery follows `nextCursor` across tools/list pages.
// ---------------------------------------------------------------------------

const JsonRpcId = Schema.Union([Schema.String, Schema.Number, Schema.Null]);
const JsonRpcRequest = Schema.Struct({
  id: Schema.optional(JsonRpcId),
  method: Schema.String,
  params: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
});
type JsonRpcRequest = typeof JsonRpcRequest.Type;

const decodeJsonRpcRequest = Schema.decodeUnknownOption(Schema.fromJsonString(JsonRpcRequest));

const jsonRpcResult = (request: JsonRpcRequest, result: unknown) =>
  HttpServerResponse.jsonUnsafe({ jsonrpc: "2.0", id: request.id ?? null, result });

const pageTool = (name: string) => ({
  name,
  description: `Tool ${name}`,
  inputSchema: { type: "object", properties: {} },
});

// A minimal paginated fixture: page1 → cursor "p2" → page2 → done.
const servePaginatedListServer = () =>
  serveTestHttpApp((request) =>
    Effect.gen(function* () {
      if (request.method === "GET") {
        return HttpServerResponse.text("SSE disabled", { status: 405 });
      }
      const body = yield* request.text.pipe(Effect.orDie);
      return Option.match(decodeJsonRpcRequest(body), {
        onNone: () => HttpServerResponse.text("Invalid JSON-RPC fixture request", { status: 400 }),
        onSome: (rpc) => {
          if (rpc.method === "initialize") {
            return jsonRpcResult(rpc, {
              protocolVersion: "2025-06-18",
              capabilities: { tools: { listChanged: true } },
              serverInfo: { name: "paginated-fixture", version: "1.0.0" },
            });
          }
          if (rpc.method === "notifications/initialized") {
            return HttpServerResponse.text("", { status: 202 });
          }
          if (rpc.method === "tools/list") {
            const cursor = rpc.params?.cursor;
            if (cursor === undefined) {
              return jsonRpcResult(rpc, {
                tools: [pageTool("alpha"), pageTool("beta")],
                nextCursor: "p2",
              });
            }
            if (cursor === "p2") {
              return jsonRpcResult(rpc, { tools: [pageTool("gamma")] });
            }
            return HttpServerResponse.text("Unknown cursor", { status: 400 });
          }
          return HttpServerResponse.text("Unexpected JSON-RPC method", { status: 400 });
        },
      });
    }),
  );

describe("MCP tools/list pagination", () => {
  it.effect("discoverTools follows nextCursor across every page", () =>
    Effect.gen(function* () {
      const server = yield* servePaginatedListServer();
      const manifest = yield* discoverTools(
        createMcpConnector({
          transport: "remote",
          endpoint: server.url("/mcp"),
          remoteTransport: "streamable-http",
        }),
      );

      expect(manifest.tools.map((tool) => tool.toolName).sort()).toEqual([
        "alpha",
        "beta",
        "gamma",
      ]);
    }),
  );
});
