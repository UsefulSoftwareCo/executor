import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";
import { FetchHttpClient } from "effect/unstable/http";

import { createMcpConnector } from "./connection";
import { makeEchoMcpServer, serveMcpServer } from "../testing";

// Raw timers, not Effect.sleep: `it.effect`'s TestClock never advances one.
const settle = (attempts: number, done: () => boolean) =>
  Effect.promise(async () => {
    for (let i = 0; i < attempts; i++) {
      if (done()) return;
      await new Promise<void>((resolve) => setTimeout(resolve, 25));
    }
  });

const connect = (endpoint: string) =>
  createMcpConnector({
    transport: "remote",
    endpoint,
    remoteTransport: "streamable-http",
    // Without a layer the SDK uses global fetch and skips the adapter.
    httpClientLayer: FetchHttpClient.layer,
  });

// `close()` has to end the request, not just drop the session: an SSE `GET`
// left in flight per dial exhausts Bun's 256-request pool, after which every
// outbound fetch queues forever.
describe("MCP connection request release", () => {
  it.effect("closing a connection ends the SSE request", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const server = yield* serveMcpServer(() => makeEchoMcpServer());

        const connection = yield* connect(server.endpoint);
        // The SSE `GET` opens asynchronously, after the handshake POSTs.
        yield* settle(40, () => server.inFlightRequests() > 0);
        expect(server.inFlightRequests()).toBeGreaterThan(0);

        yield* Effect.promise(() => connection.close());
        yield* settle(40, () => server.inFlightRequests() === 0);

        expect(server.inFlightRequests()).toBe(0);
      }),
    ),
  );

  it.effect("repeated connect/close does not accumulate open requests", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const server = yield* serveMcpServer(() => makeEchoMcpServer());

        for (let i = 0; i < 5; i++) {
          const connection = yield* connect(server.endpoint);
          yield* Effect.promise(() => connection.close());
        }
        yield* settle(40, () => server.inFlightRequests() === 0);

        expect(server.sessionCount()).toBe(5);
        expect(server.inFlightRequests()).toBe(0);
      }),
    ),
  );
});
