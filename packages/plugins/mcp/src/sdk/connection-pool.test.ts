import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";
import { ElicitationResponse, type Elicit } from "@executor-js/sdk";

import { createMcpConnector } from "./connection";
import { createMcpConnectionPool } from "./connection-pool";
import { invokeMcpTool } from "./invoke";
import { makeEchoMcpServer, serveMcpServer } from "../testing";

const acceptAll: Elicit = () =>
  Effect.succeed(ElicitationResponse.make({ action: "accept", content: { approved: true } }));

const invoke = (input: {
  readonly endpoint: string;
  readonly pool: ReturnType<typeof createMcpConnectionPool>;
  readonly toolName: string;
  readonly args: Record<string, unknown>;
  readonly elicit?: Elicit;
}) =>
  invokeMcpTool({
    toolId: input.toolName,
    toolName: input.toolName,
    args: input.args,
    transport: "streamable-http",
    connector: createMcpConnector({
      transport: "remote",
      endpoint: input.endpoint,
      remoteTransport: "streamable-http",
    }),
    connectionPool: input.pool,
    connectionPoolKey: input.endpoint,
    elicit: input.elicit ?? acceptAll,
  });

describe("MCP connection pool", () => {
  it.effect("reuses one session for sequential invokes", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const server = yield* serveMcpServer(() => makeEchoMcpServer());
        const pool = createMcpConnectionPool();

        const first = yield* invoke({
          endpoint: server.endpoint,
          pool,
          toolName: "echo",
          args: { value: "first" },
        });
        const second = yield* invoke({
          endpoint: server.endpoint,
          pool,
          toolName: "echo",
          args: { value: "second" },
        });

        expect(first).toMatchObject({ content: [{ type: "text", text: "first" }] });
        expect(second).toMatchObject({ content: [{ type: "text", text: "second" }] });
        expect(server.sessionCount()).toBe(1);
        yield* pool.close();
      }),
    ),
  );

  it.effect("leases separate sessions to concurrent invokes", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const server = yield* serveMcpServer(() => makeEchoMcpServer());
        const pool = createMcpConnectionPool();

        const results = yield* Effect.all(
          [
            invoke({
              endpoint: server.endpoint,
              pool,
              toolName: "echo",
              args: { value: "left" },
            }),
            invoke({
              endpoint: server.endpoint,
              pool,
              toolName: "echo",
              args: { value: "right" },
            }),
          ],
          { concurrency: "unbounded" },
        );

        expect(results).toEqual([
          expect.objectContaining({ content: [{ type: "text", text: "left" }] }),
          expect.objectContaining({ content: [{ type: "text", text: "right" }] }),
        ]);
        expect(server.sessionCount()).toBe(2);
        yield* pool.close();
      }),
    ),
  );

  it.effect("redials once when a reused session has expired", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const server = yield* serveMcpServer(() => makeEchoMcpServer());
        const pool = createMcpConnectionPool();

        yield* invoke({
          endpoint: server.endpoint,
          pool,
          toolName: "echo",
          args: { value: "before" },
        });
        yield* server.forgetSessions;
        const after = yield* invoke({
          endpoint: server.endpoint,
          pool,
          toolName: "echo",
          args: { value: "after" },
        });

        expect(after).toMatchObject({ content: [{ type: "text", text: "after" }] });
        expect(server.sessionCount()).toBe(2);
        yield* pool.close();
      }),
    ),
  );

  it.effect("drops a connection after a transport-level invocation failure", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const server = yield* serveMcpServer(() => makeEchoMcpServer());
        const pool = createMcpConnectionPool();

        yield* invoke({
          endpoint: server.endpoint,
          pool,
          toolName: "echo",
          args: { value: "before" },
        });
        yield* server.rejectNextSessionRequest(500);
        yield* invoke({
          endpoint: server.endpoint,
          pool,
          toolName: "echo",
          args: { value: "fails" },
        }).pipe(Effect.flip);
        const after = yield* invoke({
          endpoint: server.endpoint,
          pool,
          toolName: "echo",
          args: { value: "after" },
        });

        expect(after).toMatchObject({ content: [{ type: "text", text: "after" }] });
        expect(server.sessionCount()).toBe(2);
        yield* pool.close();
      }),
    ),
  );
});
