import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";

import { createMcpConnector, type McpConnector } from "./connection";
import { discoverTools } from "./discover";
import { makeEchoMcpServer, serveMcpServer } from "../testing";

// Exercise the real MCP handshake and catalog. The connector owns teardown,
// so a wrapper can reproduce a transport that closes its sockets but never
// settles its close promise without replacing the protocol client.
const hangingCloseConnector = (connector: McpConnector, state: { closes: number }): McpConnector =>
  Effect.map(connector, (connection) => ({
    client: connection.client,
    close: async () => {
      state.closes += 1;
      await connection.close();
      return new Promise<void>(() => {});
    },
  }));

describe("MCP discovery teardown", () => {
  it.live("preserves a real catalog when close never settles", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const server = yield* serveMcpServer(() => makeEchoMcpServer({ name: "hanging-close" }));
        const state = { closes: 0 };
        const manifest = yield* discoverTools(
          hangingCloseConnector(
            createMcpConnector({
              transport: "remote",
              endpoint: server.url,
              remoteTransport: "streamable-http",
            }),
            state,
          ),
        );
        expect(state.closes).toBe(1);
        expect(manifest.server?.name).toBe("hanging-close");
        expect(manifest.tools.length).toBeGreaterThan(0);
      }),
    ),
  );

  it.live("preserves listing failure when close never settles", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const server = yield* serveMcpServer(() => makeEchoMcpServer());
        yield* server.rejectSessionMethod("tools/list", 403);
        const state = { closes: 0 };
        const result = yield* discoverTools(
          hangingCloseConnector(
            createMcpConnector({
              transport: "remote",
              endpoint: server.url,
              remoteTransport: "streamable-http",
            }),
            state,
          ),
        ).pipe(Effect.result);
        expect(state.closes).toBe(1);
        expect(result).toMatchObject({
          _tag: "Failure",
          failure: { stage: "list_tools", httpStatus: 403 },
        });
      }),
    ),
  );
});
