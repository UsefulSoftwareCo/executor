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
import { Deferred, Effect, Fiber, Option, Ref, Schema } from "effect";
import { HttpServerResponse } from "effect/unstable/http";

import {
  AuthTemplateSlug,
  ConnectionName,
  IntegrationSlug,
  STALE_TOOLS_SYNC_CONCURRENCY,
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

  it.effect("preserves the MCP discovery failure in degraded connection health", () =>
    Effect.gen(function* () {
      const server = yield* serveTestHttpApp(() =>
        Effect.succeed(HttpServerResponse.text("gateway unavailable", { status: 503 })),
      );
      const executor = yield* makeCatalogTestExecutor(server.url("/mcp"));
      const connection = yield* executor.connections.get({
        owner: "org",
        integration: INTEG,
        name: CONNECTION,
      });

      expect(connection?.lastHealth).toMatchObject({
        status: "degraded",
        detail: expect.stringContaining("Failed connecting to MCP server"),
      });
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

// ---------------------------------------------------------------------------
// Stale-catalog refresh concurrency.
//
// A tools read rebuilds every stale connection it finds. Each rebuild is an
// independent upstream listing, so a host with several stale remote catalogs
// must not pay the sum of every server's latency on the read that trips the
// TTL. Nor may one read open an unbounded number of upstream listings.
//
// The fixture below refuses to answer any listing until the bound is reached,
// which pins both edges at once: a serial refresh parks on the first listing
// and never finishes, while an unbounded refresh puts more than
// STALE_TOOLS_SYNC_CONCURRENCY listings in flight. The stale set is deliberately
// one larger than the bound, so the last connection can only be served after an
// earlier one completes.
// ---------------------------------------------------------------------------

const STALE_CONNECTIONS = STALE_TOOLS_SYNC_CONCURRENCY + 1;

const serveLatchedListServer = () =>
  Effect.gen(function* () {
    const armed = yield* Ref.make(false);
    const listings = yield* Ref.make(0);
    // Signalled when the bound is saturated; released by the test, not by the
    // fixture, so the test can first prove nothing beyond the bound arrives.
    const atLimit = yield* Deferred.make<void>();
    const release = yield* Deferred.make<void>();

    const server = yield* serveTestHttpApp((request) =>
      Effect.gen(function* () {
        if (request.method === "GET") {
          return HttpServerResponse.text("SSE disabled", { status: 405 });
        }
        const body = yield* request.text.pipe(Effect.orDie);
        const rpc = Option.getOrUndefined(decodeJsonRpcRequest(body));
        if (!rpc) {
          return HttpServerResponse.text("Invalid JSON-RPC fixture request", { status: 400 });
        }
        if (rpc.method === "initialize") {
          return jsonRpcResult(rpc, {
            protocolVersion: "2025-06-18",
            capabilities: { tools: { listChanged: true } },
            serverInfo: { name: "latched-fixture", version: "1.0.0" },
          });
        }
        if (rpc.method === "notifications/initialized") {
          return HttpServerResponse.text("", { status: 202 });
        }
        if (rpc.method !== "tools/list") {
          return HttpServerResponse.text("Unexpected JSON-RPC method", { status: 400 });
        }
        // Once armed, park every listing until the test releases them. A serial
        // refresh parks on the first one and never reaches the bound.
        if (yield* Ref.get(armed)) {
          const arrived = yield* Ref.updateAndGet(listings, (n) => n + 1);
          if (arrived >= STALE_TOOLS_SYNC_CONCURRENCY) {
            yield* Deferred.succeed(atLimit, undefined);
          }
          yield* Deferred.await(release);
        }
        return jsonRpcResult(rpc, { tools: [pageTool("alpha")] });
      }),
    );

    return {
      // Distinct endpoint paths so each connection dials its own MCP session
      // instead of sharing one pooled client.
      endpoint: (index: number) => server.url(`/mcp/${index}`),
      arm: Ref.set(armed, true),
      awaitLimit: Deferred.await(atLimit),
      release: Deferred.succeed(release, undefined),
      listings: Ref.get(listings),
    } as const;
  });

describe("MCP stale-catalog refresh", () => {
  // `it.live` (real clock): proving that nothing beyond the bound is dialled
  // means giving a real HTTP round trip a real window to happen in, and the
  // timeouts below must actually fire. The TestClock advances neither.
  it.live("rebuilds stale connections concurrently up to the bound, then queues the rest", () =>
    Effect.gen(function* () {
      const fixture = yield* serveLatchedListServer();
      const executor = yield* createExecutor({
        ...makeTestConfig({ plugins: [memoryCredentialsPlugin(), mcpPlugin()] as const }),
        // Everything is expired on every read, so a single tools read has the
        // whole set to rebuild.
        toolsSyncTtlMs: 0,
      });

      for (let index = 0; index < STALE_CONNECTIONS; index++) {
        const slug = IntegrationSlug.make(`latched_mcp_${index}`);
        yield* executor.mcp.addServer({
          name: `latched-mcp-${index}`,
          endpoint: fixture.endpoint(index),
          slug: String(slug),
        });
        yield* executor.connections.create({
          owner: "org",
          name: CONNECTION,
          integration: slug,
          template: TEMPLATE,
          value: "",
        });
      }

      // Warm every catalog while the fixture still answers freely, so the
      // latched read below is purely the stale-refresh fan-out.
      yield* executor.tools.list();
      yield* fixture.arm;

      const readFiber = yield* Effect.forkChild(executor.tools.list());

      // Timeouts are well inside the harness limit, so a broken fan-out fails
      // on an assertion here rather than as an opaque test-runner timeout.
      // A serial refresh never saturates the bound and fails on this line.
      const saturated = yield* fixture.awaitLimit.pipe(Effect.timeoutOption("10 seconds"));
      expect(Option.isSome(saturated)).toBe(true);

      // The bound is reached and every one of those listings is still parked.
      // Give an unbounded fan-out ample time to dial the remaining connection:
      // it never may, because no permit has been given back yet.
      yield* Effect.sleep("500 millis");
      expect(yield* fixture.listings).toBe(STALE_TOOLS_SYNC_CONCURRENCY);

      // Releasing the parked listings frees permits, and only then does the
      // last connection get dialled.
      yield* fixture.release;
      const refreshed = yield* Fiber.join(readFiber).pipe(Effect.timeoutOption("10 seconds"));
      expect(Option.isSome(refreshed)).toBe(true);
      expect(yield* fixture.listings).toBe(STALE_CONNECTIONS);
    }),
  );
});
