import { describe, expect, it } from "@effect/vitest";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import {
  ErrorCode,
  LATEST_PROTOCOL_VERSION,
  type JSONRPCMessage,
} from "@modelcontextprotocol/sdk/types.js";
import { Effect, Option, Schema } from "effect";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const repoRoot = resolve(import.meta.dirname, "../../../..");
const cliEntry = resolve(repoRoot, "apps/cli/src/main.ts");
const testScope = resolve(repoRoot, "apps/local");

const decodeServerManifest = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Struct({ pid: Schema.optional(Schema.Number) })),
);

const stopAutoSpawnedDaemon = (dataDir: string): Effect.Effect<void> =>
  Effect.try({
    try: () => readFileSync(join(dataDir, "server-control", "server.json"), "utf8"),
    catch: () => undefined,
  }).pipe(
    Effect.flatMap((text) => {
      const manifest = decodeServerManifest(text);
      const pid = Option.isSome(manifest) ? manifest.value.pid : undefined;
      return pid
        ? Effect.try({
            try: () => process.kill(pid, "SIGTERM"),
            catch: () => undefined,
          }).pipe(Effect.ignore)
        : Effect.void;
    }),
    Effect.ignore,
  );

const withTempData = Effect.acquireRelease(
  Effect.sync(() => mkdtempSync(join(tmpdir(), "executor-mcp-discover-test-"))),
  (dataDir) =>
    stopAutoSpawnedDaemon(dataDir).pipe(
      Effect.ensuring(Effect.sync(() => rmSync(dataDir, { recursive: true, force: true }))),
    ),
);

const messageQueue = (transport: StdioClientTransport) => {
  const messages: Array<JSONRPCMessage> = [];
  const waiters: Array<(message: JSONRPCMessage) => void> = [];

  transport.onmessage = (message) => {
    const waiter = waiters.shift();
    if (waiter) {
      waiter(message);
    } else {
      messages.push(message);
    }
  };

  return {
    next: (): Promise<JSONRPCMessage> => {
      const message = messages.shift();
      return message ? Promise.resolve(message) : new Promise((resolve) => waiters.push(resolve));
    },
  };
};

describe("MCP stdio integration", () => {
  it.effect(
    "unsupported discovery keeps the connection open for initialization and tool calls",
    () =>
      Effect.gen(function* () {
        const dataDir = yield* withTempData;
        const transport = new StdioClientTransport({
          command: "bun",
          args: ["run", cliEntry, "mcp", "--scope", testScope],
          env: { ...process.env, EXECUTOR_DATA_DIR: dataDir },
        });
        const responses = messageQueue(transport);

        yield* Effect.acquireRelease(
          Effect.promise(() => transport.start()),
          () => Effect.promise(() => transport.close()),
        );

        yield* Effect.promise(() =>
          transport.send({
            jsonrpc: "2.0",
            id: 1,
            method: "server/discover",
            params: {
              _meta: {
                "io.modelcontextprotocol/protocolVersion": "2026-07-28",
                "io.modelcontextprotocol/clientInfo": {
                  name: "discovery-test-client",
                  version: "1.0.0",
                },
                "io.modelcontextprotocol/clientCapabilities": {},
              },
            },
          }),
        );

        expect(yield* Effect.promise(() => responses.next())).toEqual({
          jsonrpc: "2.0",
          id: 1,
          error: {
            code: ErrorCode.MethodNotFound,
            message: "Method not found",
          },
        });

        yield* Effect.promise(() =>
          transport.send({
            jsonrpc: "2.0",
            id: 2,
            method: "initialize",
            params: {
              protocolVersion: LATEST_PROTOCOL_VERSION,
              capabilities: {},
              clientInfo: {
                name: "discovery-test-client",
                version: "1.0.0",
              },
            },
          }),
        );

        const initialize = yield* Effect.promise(() => responses.next());
        expect(initialize).toHaveProperty("result.protocolVersion");

        yield* Effect.promise(() =>
          transport.send({
            jsonrpc: "2.0",
            method: "notifications/initialized",
          }),
        );
        yield* Effect.promise(() =>
          transport.send({
            jsonrpc: "2.0",
            id: 3,
            method: "tools/list",
            params: {},
          }),
        );

        const listed = yield* Effect.promise(() => responses.next());
        expect(listed).toHaveProperty(
          "result.tools",
          expect.arrayContaining([expect.objectContaining({ name: "execute" })]),
        );

        yield* Effect.promise(() =>
          transport.send({
            jsonrpc: "2.0",
            id: 4,
            method: "tools/call",
            params: {
              name: "execute",
              arguments: { code: "return 2+2" },
            },
          }),
        );

        const called = yield* Effect.promise(() => responses.next());
        expect(called).toHaveProperty(
          "result.content",
          expect.arrayContaining([expect.objectContaining({ text: expect.stringContaining("4") })]),
        );
      }).pipe(Effect.scoped),
    { timeout: 30_000 },
  );
});
