// Unit coverage for the POST-stream priming SSE event (see
// patches/agents@0.17.3.patch). Executor's POST tools/call stream used to emit
// its first and only event `id:` together with the final result, so the MCP TS
// SDK's StreamableHTTPClientTransport never set hasPrimingEvent and would not
// auto-reconnect a stream that dropped mid-call: callTool hung while the DO
// held the completed result. The patch writes a priming event as the first
// frame on the POST stream, carrying a real event-store id that sorts before
// the response so a `last-event-id: <primingId>` reconnect replays the result.
//
// Two properties are pinned here against real code:
//   1. Event-store ordering + replay: with the real DurableObjectEventStore, a
//      priming event stored before the response sorts first, and
//      replayEventsAfter(primingId) yields exactly the response.
//   2. Client contract: fed the exact priming frame the transport emits, the
//      real SDK StreamableHTTPClientTransport records the priming id (so it
//      would reconnect) WITHOUT dispatching it as a JSON-RPC message, then
//      dispatches a following result frame normally.
import { describe, expect, it } from "@effect/vitest";
import { DurableObjectEventStore } from "agents/mcp";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";

type ListOptions = {
  readonly prefix?: string;
  readonly start?: string;
  readonly limit?: number;
  readonly reverse?: boolean;
};

/** Minimal in-memory stand-in for DurableObjectStorage's sorted KV surface. */
const makeFakeStorage = () => {
  const entries = new Map<string, unknown>();
  return {
    entries,
    put: (key: string, value: unknown) => {
      entries.set(key, value);
      return Promise.resolve();
    },
    delete: (keys: string | ReadonlyArray<string>) => {
      for (const key of Array.isArray(keys) ? keys : [keys]) entries.delete(key);
      return Promise.resolve();
    },
    list: (options: ListOptions = {}) => {
      const keys = [...entries.keys()]
        .filter((key) => (options.prefix === undefined ? true : key.startsWith(options.prefix)))
        .filter((key) => (options.start === undefined ? true : key >= options.start))
        .sort();
      if (options.reverse === true) keys.reverse();
      const limited = options.limit === undefined ? keys : keys.slice(0, options.limit);
      return Promise.resolve(new Map(limited.map((key) => [key, entries.get(key)])));
    },
  };
};

// The exact priming notification the patched transport persists, and the exact
// SSE frame it writes to the client. Mirrors emitPrimingEvent /
// writePrimingSSEEvent in patches/agents@0.17.3.patch: a benign JSON-RPC
// notification stored (so a plain-GET replay via writeSSEEvent is ignorable),
// framed live under a non-`message` event type so the SDK primes but does not
// dispatch it.
const PRIMING_MESSAGE = {
  jsonrpc: "2.0" as const,
  method: "notifications/message",
  params: { level: "debug", data: "mcp-stream-priming" },
};
const primingFrame = (eventId: string): string =>
  `event: mcp-priming\nid: ${eventId}\ndata: ${JSON.stringify(PRIMING_MESSAGE)}\n\n`;
const messageFrame = (eventId: string, message: unknown): string =>
  `event: message\nid: ${eventId}\ndata: ${JSON.stringify(message)}\n\n`;

describe("POST-stream priming event: store ordering and replay", () => {
  it("persists the priming event before the response so replayEventsAfter(primingId) yields the response", async () => {
    const storage = makeFakeStorage();
    const store = new DurableObjectEventStore(storage as never);
    const streamId = "post-stream";

    // Transport order: priming event first, then the tool response. Both are
    // tiny, so storeEvent always persists them and returns an id — the
    // `undefined` arm of its signature is the oversize skip, pinned in
    // agents-event-store.test.ts.
    const primingId = await store.storeEvent(streamId, PRIMING_MESSAGE);
    const response = {
      jsonrpc: "2.0" as const,
      id: 1,
      result: { content: [{ type: "text", text: "MARKER" }] },
    };
    const responseId = await store.storeEvent(streamId, response);

    expect(primingId, "priming event is seq 1 for the stream").toBe(`${streamId}:0000000000000001`);
    expect(responseId, "response is seq 2, after the priming id").toBe(
      `${streamId}:0000000000000002`,
    );
    expect(
      (primingId ?? "") < (responseId ?? ""),
      "priming id sorts strictly before the response id",
    ).toBe(true);

    const replayed: Array<{ readonly eventId: string; readonly message: unknown }> = [];
    await store.replayEventsAfter(primingId ?? "", {
      send: async (eventId: string, message: unknown) => {
        replayed.push({ eventId, message });
      },
    });

    expect(
      replayed.map((entry) => entry.eventId),
      "a reconnect with last-event-id=<primingId> replays exactly the response",
    ).toEqual([responseId]);
    expect(replayed[0]?.message).toEqual(response);
  });

  it("does not replay the priming event itself on a last-event-id reconnect", async () => {
    const storage = makeFakeStorage();
    const store = new DurableObjectEventStore(storage as never);
    const streamId = "post-stream";
    const primingId = await store.storeEvent(streamId, PRIMING_MESSAGE);
    expect(primingId, "a tiny priming message always persists and gets an id").toBeDefined();

    const replayed: string[] = [];
    await store.replayEventsAfter(primingId ?? "", {
      send: async (eventId: string) => {
        replayed.push(eventId);
      },
    });

    expect(replayed, "nothing after the priming event yet, so replay is empty").toEqual([]);
  });
});

describe("POST-stream priming event: SDK client contract", () => {
  // Drive the real SDK StreamableHTTPClientTransport with a controlled fetch
  // that returns a POST tools/call SSE stream: priming frame first, then the
  // result. Assert the SDK records the priming id as a resumption token (so it
  // would reconnect) but only dispatches the result as a JSON-RPC message.
  const drivePostStream = async (frames: ReadonlyArray<string>) => {
    const encoder = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const frame of frames) controller.enqueue(encoder.encode(frame));
        controller.close();
      },
    });
    // oxlint-disable-next-line executor/no-double-cast -- boundary: a minimal fetch stub for a unit test; only the Response shape the SDK reads matters.
    const fetchStub = (async () =>
      new Response(body, {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      })) as unknown as typeof fetch;

    const transport = new StreamableHTTPClientTransport(new URL("https://executor.sh/mcp"), {
      fetch: fetchStub,
    });

    const messages: JSONRPCMessage[] = [];
    const resumptionTokens: string[] = [];
    transport.onmessage = (message) => {
      messages.push(message);
    };

    await transport.start();
    // POST a tools/call request; the stub returns the SSE stream above.
    await transport.send(
      { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "execute", arguments: {} } },
      {
        onresumptiontoken: (token: string) => {
          resumptionTokens.push(token);
        },
      },
    );
    // Let the SSE stream drain.
    for (let i = 0; i < 20; i += 1) await Promise.resolve();
    await transport.close();
    return { messages, resumptionTokens };
  };

  it("records the priming id as a resumption token without dispatching it, then dispatches the result", async () => {
    const primingId = "post-stream:0000000000000001";
    const responseId = "post-stream:0000000000000002";
    const result = {
      jsonrpc: "2.0" as const,
      id: 1,
      result: { content: [{ type: "text", text: "MARKER" }] },
    };

    const { messages, resumptionTokens } = await drivePostStream([
      primingFrame(primingId),
      messageFrame(responseId, result),
    ]);

    expect(
      resumptionTokens,
      "the SDK records the priming id first (this is what sets hasPrimingEvent), then the response id",
    ).toEqual([primingId, responseId]);
    expect(
      messages,
      "the priming frame is NOT dispatched as a JSON-RPC message; only the result is",
    ).toEqual([result]);
  });

  it("would not prime on a stream whose first event id arrives only with the result (the old behavior)", async () => {
    // Sanity anchor for the fix: without a priming frame, the first recorded
    // resumption token is the result's own id, which the SDK only sees at the
    // same instant it receives the result. There is no earlier id to reconnect
    // from, which is exactly the hang this patch removes.
    const responseId = "post-stream:0000000000000001";
    const result = {
      jsonrpc: "2.0" as const,
      id: 1,
      result: { content: [{ type: "text", text: "MARKER" }] },
    };

    const { messages, resumptionTokens } = await drivePostStream([
      messageFrame(responseId, result),
    ]);

    expect(resumptionTokens, "the only id ever seen is the result's own id").toEqual([responseId]);
    expect(messages).toEqual([result]);
  });
});
