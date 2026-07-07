import { afterEach, beforeEach, describe, expect, it, vi } from "@effect/vitest";
import { McpAgent } from "agents/mcp";
import { Option, Schema } from "effect";

// Regression coverage for the worker<->DO bridge unknown-frame tolerance added
// in patches/agents@0.17.3.patch. Under a gradual (staged) deployment the
// worker and DO can run different versions for the duration of a rollout, so a
// newer peer may emit a bridge frame `type` the older peer does not recognize.
// The bridge MUST ignore such a frame without breaking the stream and log it
// once (structured: { event: "mcp_bridge_unknown_frame", frameType, direction })
// so the skew is observable in Axiom.
//
// These tests drive the REAL patched `agents/mcp` streaming handler (the
// worker-side POST bridge onMessage) with a fake DO websocket, exactly as
// agents-sse-max-age.test.ts does, so they exercise the shipped dist, not a
// re-implementation.

type FakeWebSocket = EventTarget & {
  accepted: boolean;
  closeCode: number | undefined;
  closeReason: string | undefined;
  sent: string[];
  accept: () => void;
  close: (code?: number, reason?: string) => void;
  send: (message: string) => void;
};

const makeWebSocket = (): FakeWebSocket => {
  const ws = new EventTarget() as FakeWebSocket;
  ws.accepted = false;
  ws.closeCode = undefined;
  ws.closeReason = undefined;
  ws.sent = [];
  ws.accept = () => {
    ws.accepted = true;
  };
  ws.close = (code?: number, reason?: string) => {
    ws.closeCode = code;
    ws.closeReason = reason;
  };
  ws.send = (message: string) => {
    ws.sent.push(message);
  };
  return ws;
};

const makeExecutionContext = (): ExecutionContext => ({
  passThroughOnException: () => {},
  props: {},
  waitUntil: () => {},
});

const makeAgentStub = (ws: FakeWebSocket) => ({
  setName: async () => undefined,
  getInitializeRequest: async () => ({}),
  fetch: async () => ({ webSocket: ws }),
});

const makeNamespace = (agent: ReturnType<typeof makeAgentStub>) => ({
  newUniqueId: () => ({ toString: () => "generated-session" }),
  idFromName: (name: string) => ({ equals: () => true, name, toString: () => name }),
  get: () => agent,
});

const openPostSse = async (): Promise<{ response: Response; ws: FakeWebSocket }> => {
  const ws = makeWebSocket();
  const agent = makeAgentStub(ws);
  const namespace = makeNamespace(agent);
  const handler = McpAgent.serve("/mcp", { binding: "MCP_SESSION", transport: "streamable-http" });
  const response = await handler.fetch(
    new Request("https://executor.sh/mcp", {
      body: JSON.stringify({
        id: 1,
        jsonrpc: "2.0",
        method: "tools/call",
        params: { arguments: {}, name: "example" },
      }),
      headers: {
        accept: "application/json, text/event-stream",
        "content-type": "application/json",
        "mcp-session-id": "session-1",
      },
      method: "POST",
    }),
    { MCP_SESSION: namespace } as never,
    makeExecutionContext(),
  );
  expect(response.status).toBe(200);
  expect(ws.accepted).toBe(true);
  expect(response.body).toBeDefined();
  return { response, ws };
};

const drainResponse = (response: Response): Promise<string> => {
  const reader = response.body?.getReader();
  if (!reader) return Promise.resolve("");
  const decoder = new TextDecoder();
  let text = "";
  const pump = async (): Promise<string> => {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      text += decoder.decode(value, { stream: true });
    }
    return text;
  };
  return pump();
};

const emitFrame = (ws: FakeWebSocket, frame: Record<string, unknown>): void => {
  ws.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(frame) }));
};

const flushMicrotasks = async (): Promise<void> => {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
};

const UnknownFrameWarning = Schema.Struct({
  direction: Schema.String,
  event: Schema.Literal("mcp_bridge_unknown_frame"),
  frameType: Schema.String,
});
type UnknownFrameWarning = typeof UnknownFrameWarning.Type;
const decodeUnknownFrameWarning = Schema.decodeUnknownOption(
  Schema.fromJsonString(UnknownFrameWarning),
);

const parseWarnings = (lines: ReadonlyArray<string>): ReadonlyArray<UnknownFrameWarning> =>
  lines.flatMap((line) => {
    const decoded = decodeUnknownFrameWarning(line);
    return Option.isSome(decoded) ? [decoded.value] : [];
  });

describe("worker<->DO bridge unknown-frame tolerance", () => {
  let warnLogs: string[] = [];
  let errorLogs: string[] = [];

  beforeEach(() => {
    warnLogs = [];
    errorLogs = [];
    vi.spyOn(console, "warn").mockImplementation((line) => {
      warnLogs.push(String(line));
    });
    vi.spyOn(console, "error").mockImplementation((line) => {
      errorLogs.push(String(line));
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("ignores an unknown bridge frame type and keeps the POST SSE stream alive", async () => {
    const { response, ws } = await openPostSse();
    const drained = drainResponse(response);

    // A newer DO emits a frame type this (older) worker has never seen.
    emitFrame(ws, { type: "cf_mcp_future_control", nonce: "abc" });
    await flushMicrotasks();

    // The stream survives: no close, no error forwarded.
    expect(ws.closeCode).toBeUndefined();
    expect(ws.closeReason).toBeUndefined();
    expect(errorLogs).toEqual([]);

    // The unknown frame is logged once, structured, with the frame type + direction.
    const warnings = parseWarnings(warnLogs);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatchObject({
      event: "mcp_bridge_unknown_frame",
      frameType: "cf_mcp_future_control",
      direction: "do->worker",
    });

    // A subsequent RECOGNIZED frame still flows through and completes the stream,
    // proving the unknown frame did not wedge the bridge.
    emitFrame(ws, {
      type: "cf_mcp_agent_event",
      event: `event: message\ndata: {"jsonrpc":"2.0","id":1,"result":{"ok":true}}\n\n`,
      close: true,
    });
    const body = await drained;
    await flushMicrotasks();
    expect(body).toContain('"ok":true');
    expect(ws.closeCode).toBe(1000);
    expect(ws.closeReason).toBe("SSE response delivered");
  });

  it("does not warn on a recognized cf_mcp_agent_event frame", async () => {
    const { response, ws } = await openPostSse();
    const drained = drainResponse(response);

    emitFrame(ws, {
      type: "cf_mcp_agent_event",
      event: `event: message\ndata: {"jsonrpc":"2.0","id":1,"result":{"ok":true}}\n\n`,
      close: true,
    });
    await drained;

    expect(parseWarnings(warnLogs)).toEqual([]);
    expect(errorLogs).toEqual([]);
  });
});
