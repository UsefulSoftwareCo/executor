// Cloud: regression test for the standalone-listener eviction storm.
//
// The MCP spec allows a client to hold a standalone SSE listener (a bare GET)
// for server-initiated messages. The patched agents SDK applies
// latest-listener-wins to that stream:
//
//   packages/... -> agents/dist/mcp/index.js:880
//   supersedePriorStreamConnections(agent, connection.id, STANDALONE_STREAM_ID)
//     -> for every OTHER connection on the same streamId: close(1000, ...)
//
// STANDALONE_STREAM_ID is shared by every listener, so a session with two
// listeners has each arrival kill the other. Any SSE client reconnects when
// its stream closes, so two listeners evict each other indefinitely: the
// session can never hold a listener open and the client sees a permanent
// "disconnected / reconnecting" churn.
//
// Observed in production: one session produced ~55,600 listener GETs over
// 6.75 hours against only 106 POSTs, arriving 3-4 within milliseconds every
// ~1.2s, each answered 200 in ~130ms.
//
// This test drives N listeners that reconnect when closed, exactly like a real
// client, and asserts the session does NOT churn.
import { expect } from "@effect/vitest";
import { Effect } from "effect";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

import { scenario } from "../src/scenario";
import { Mcp, Target } from "../src/services";
import type { Identity } from "../src/target";

const emailOf = (identity: Identity): string => identity.credentials?.email ?? identity.label;

const RUN_MS = 15_000;
const SCENARIO_TIMEOUT_MS = RUN_MS + 120_000;

interface Trial {
  readonly opens: number;
  readonly medianLifeMs: number;
}

/** Hold `count` standalone listeners for RUN_MS, reconnecting whenever the
 *  server closes one — the behaviour of any real SSE client. */
const driveListeners = async (
  mcpUrl: string,
  bearer: string,
  sessionId: string,
  count: number,
): Promise<Trial> => {
  const deadline = Date.now() + RUN_MS;
  const lifetimes: number[] = [];
  let opens = 0;

  const listener = async (): Promise<void> => {
    while (Date.now() < deadline) {
      const started = Date.now();
      const controller = new AbortController();
      const guard = setTimeout(() => controller.abort(), Math.max(500, deadline - Date.now()));
      try {
        const res = await fetch(mcpUrl, {
          method: "GET",
          headers: {
            authorization: `Bearer ${bearer}`,
            accept: "text/event-stream",
            "mcp-session-id": sessionId,
            "mcp-protocol-version": "2025-06-18",
          },
          signal: controller.signal,
        });
        opens += 1;
        const reader = res.body?.getReader();
        // Read until the SERVER closes the stream.
        if (reader) {
          for (;;) {
            const { done } = await reader.read();
            if (done) break;
          }
        }
      } catch {
        // aborted at the deadline, or the socket was torn down
      }
      clearTimeout(guard);
      lifetimes.push(Date.now() - started);
    }
  };

  await Promise.all(Array.from({ length: count }, () => listener()));
  const sorted = [...lifetimes].sort((a, b) => a - b);
  return { opens, medianLifeMs: sorted[Math.floor(sorted.length / 2)] ?? 0 };
};

scenario(
  "REGRESSION · a second standalone listener must not evict the first",
  { timeout: SCENARIO_TIMEOUT_MS },
  Effect.gen(function* () {
    const target = yield* Target;
    const mcp = yield* Mcp;
    const identity = yield* target.newIdentity();
    const bearer = yield* mcp.mintBearer(emailOf(identity));

    const client = new Client({ name: "e2e-supersede", version: "0.0.1" }, { capabilities: {} });
    const transport = new StreamableHTTPClientTransport(new URL(target.mcpUrl), {
      requestInit: { headers: { authorization: `Bearer ${bearer}` } },
    });
    yield* Effect.promise(() => client.connect(transport));
    const sessionId = transport.sessionId;
    expect(sessionId, "the client got a session id").toEqual(expect.any(String));
    if (sessionId === undefined) return yield* Effect.die("missing session id");
    yield* Effect.promise(() => client.close().catch(() => undefined));

    // Control: a single listener should simply stay open for the whole window.
    const single = yield* Effect.promise(() => driveListeners(target.mcpUrl, bearer, sessionId, 1));
    console.log(JSON.stringify({ event: "supersede_single", ...single }));

    // Two listeners, each reconnecting when closed.
    const double = yield* Effect.promise(() => driveListeners(target.mcpUrl, bearer, sessionId, 2));
    console.log(JSON.stringify({ event: "supersede_double", ...double }));

    // One listener over a 15s window opens roughly once (a max-age rotation
    // could add one more). Anything beyond a handful is the eviction storm.
    expect(single.opens, "a single listener does not churn").toBeLessThanOrEqual(3);

    // The regression: two listeners must not evict each other. Without the fix
    // this is in the hundreds, with a median stream life of ~200ms.
    expect(double.opens, "two listeners do not evict each other").toBeLessThanOrEqual(6);
    expect(double.medianLifeMs, "streams stay open rather than dying instantly").toBeGreaterThan(
      2_000,
    );
  }),
);
