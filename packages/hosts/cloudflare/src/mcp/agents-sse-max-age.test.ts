import { afterEach, beforeEach, describe, expect, it, vi } from "@effect/vitest";
import { MAX_SSE_AGE_MS, McpAgent } from "agents/mcp";
import { Effect, Option, Schema } from "effect";

import { SESSION_TIMEOUT_MS } from "./session-alarm-policy";

const KEEPALIVE_INTERVAL_MS = 25_000;
const MAX_PENDING_SSE_BYTES = 8 * 1024 * 1024;

type FakeWebSocket = EventTarget & {
  accepted: boolean;
  closeCode: number | undefined;
  closeReason: string | undefined;
  accept: () => void;
  close: (code?: number, reason?: string) => void;
};

type FakeAgentStub = {
  readonly setName: (name: string, props?: unknown) => Promise<void>;
  readonly getInitializeRequest: () => Promise<unknown>;
  readonly fetch: (request: Request) => Promise<{ readonly webSocket: FakeWebSocket }>;
};

type RotationLog = {
  readonly event: "sse_max_age_close";
  readonly sessionId: string;
  readonly variant: "streamable-get" | "streamable-post" | "legacy-sse";
  readonly ageMs: number;
  readonly pendingBytes: number;
};

const encoder = new TextEncoder();
const RotationLogEvent = Schema.Struct({
  ageMs: Schema.Number,
  event: Schema.Literal("sse_max_age_close"),
  pendingBytes: Schema.Number,
  sessionId: Schema.String,
  variant: Schema.Union([
    Schema.Literal("streamable-get"),
    Schema.Literal("streamable-post"),
    Schema.Literal("legacy-sse"),
  ]),
});
const decodeRotationLogEvent = Schema.decodeUnknownOption(Schema.fromJsonString(RotationLogEvent));

const flushMicrotasks = async (): Promise<void> => {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
};

const waitFor = async (predicate: () => boolean): Promise<void> => {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (predicate()) return;
    await flushMicrotasks();
  }
  expect(predicate()).toBe(true);
};

const drainResponse = async (response: Response): Promise<string> => {
  const decoder = new TextDecoder();
  let body = "";

  await Effect.runPromise(
    Effect.ignore(
      Effect.tryPromise({
        try: () =>
          response.body?.pipeTo(
            new WritableStream<Uint8Array>({
              close: () => {
                body += decoder.decode();
              },
              write: (chunk) => {
                body += decoder.decode(chunk, { stream: true });
              },
            }),
          ) ?? Promise.resolve(),
        catch: () => undefined,
      }),
    ),
  );

  return body;
};

const installStallingTransformStream = () => {
  let abortReason: unknown;
  let writeCount = 0;
  let stalledWriteStarted: (() => void) | undefined;
  const stalledWrite = new Promise<void>((resolve) => {
    stalledWriteStarted = resolve;
  });
  const writer = {
    abort: (reason: unknown) => {
      abortReason = reason;
      return Promise.resolve();
    },
    close: () => Promise.resolve(),
    write: () => {
      writeCount += 1;
      stalledWriteStarted?.();
      return new Promise<void>(() => {});
    },
  };

  vi.stubGlobal(
    "TransformStream",
    class {
      readonly readable = new ReadableStream<Uint8Array>();
      readonly writable = {
        getWriter: () => writer,
      };
    },
  );

  return {
    abortReason: () => abortReason,
    stalledWrite,
    writeCount: () => writeCount,
  };
};

const makeExecutionContext = (): ExecutionContext => ({
  passThroughOnException: () => {},
  props: undefined,
  waitUntil: () => {},
});

const makeWebSocket = (): FakeWebSocket => {
  const ws = new EventTarget() as FakeWebSocket;
  ws.accepted = false;
  ws.closeCode = undefined;
  ws.closeReason = undefined;
  ws.accept = () => {
    ws.accepted = true;
  };
  ws.close = (code?: number, reason?: string) => {
    ws.closeCode = code;
    ws.closeReason = reason;
  };
  return ws;
};

const makeAgentStub = (ws: FakeWebSocket): FakeAgentStub => ({
  setName: async () => {},
  getInitializeRequest: async () => ({}),
  fetch: async () => ({ webSocket: ws }),
});

const makeNamespace = (agent: FakeAgentStub) => ({
  newUniqueId: () => ({ toString: () => "generated-session" }),
  idFromName: (name: string) => ({
    equals: () => true,
    name,
    toString: () => name,
  }),
  get: () => agent,
});

const openSse = async () => {
  const ws = makeWebSocket();
  const agent = makeAgentStub(ws);
  const namespace = makeNamespace(agent);
  const handler = McpAgent.serve("/mcp", {
    binding: "MCP_SESSION",
    transport: "streamable-http",
  });
  const response = await handler.fetch(
    new Request("https://executor.sh/mcp", {
      headers: {
        accept: "text/event-stream",
        "mcp-session-id": "session-1",
      },
      method: "GET",
    }),
    { MCP_SESSION: namespace },
    makeExecutionContext(),
  );

  expect(response.status).toBe(200);
  expect(ws.accepted).toBe(true);
  expect(response.body).toBeDefined();

  return { response, ws };
};

const openPostSse = async () => {
  const ws = makeWebSocket();
  const agent = makeAgentStub(ws);
  const namespace = makeNamespace(agent);
  const handler = McpAgent.serve("/mcp", {
    binding: "MCP_SESSION",
    transport: "streamable-http",
  });
  const response = await handler.fetch(
    new Request("https://executor.sh/mcp", {
      body: JSON.stringify({
        id: 1,
        jsonrpc: "2.0",
        method: "tools/call",
        params: {
          arguments: {},
          name: "example",
        },
      }),
      headers: {
        accept: "application/json, text/event-stream",
        "content-type": "application/json",
        "mcp-session-id": "session-1",
      },
      method: "POST",
    }),
    { MCP_SESSION: namespace },
    makeExecutionContext(),
  );

  expect(response.status).toBe(200);
  expect(ws.accepted).toBe(true);
  expect(response.body).toBeDefined();

  return { response, ws };
};

const emitAgentEvent = (ws: FakeWebSocket, event: string, close?: true): void => {
  ws.dispatchEvent(
    new MessageEvent("message", {
      data: JSON.stringify({
        close,
        event,
        type: "cf_mcp_agent_event",
      }),
    }),
  );
};

const emitClose = (ws: FakeWebSocket): void => {
  ws.dispatchEvent(new Event("close"));
};

const rotationLogs = (logs: ReadonlyArray<string>): ReadonlyArray<RotationLog> =>
  logs.flatMap((line) => {
    const decoded = decodeRotationLogEvent(line);
    return Option.isSome(decoded) ? [decoded.value] : [];
  });

describe("agents SSE max-age rotation", () => {
  let errorLogs: string[] = [];
  let infoLogs: string[] = [];

  beforeEach(() => {
    errorLogs = [];
    infoLogs = [];
    vi.useFakeTimers();
    vi.setSystemTime(0);
    vi.spyOn(console, "error").mockImplementation((line) => {
      errorLogs.push(String(line));
    });
    vi.spyOn(console, "log").mockImplementation((line) => {
      infoLogs.push(String(line));
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("keeps the default max age well above the session idle timeout", () => {
    expect(MAX_SSE_AGE_MS).toBe(30 * 60 * 1000);
    expect(MAX_SSE_AGE_MS).toBeGreaterThanOrEqual(6 * SESSION_TIMEOUT_MS);
  });

  it("closes a healthy draining SSE connection within one keepalive tick after max age", async () => {
    const { response, ws } = await openSse();
    const drained = drainResponse(response);

    await vi.advanceTimersByTimeAsync(MAX_SSE_AGE_MS + KEEPALIVE_INTERVAL_MS);
    await waitFor(() => ws.closeCode === 1000);

    expect(ws.closeReason).toBe("sse_max_age_rotation");
    const [rotationLog] = rotationLogs(infoLogs);
    expect(rotationLog?.event).toBe("sse_max_age_close");
    expect(rotationLog?.ageMs).toBeGreaterThan(MAX_SSE_AGE_MS);
    expect(rotationLog?.ageMs).toBeLessThanOrEqual(MAX_SSE_AGE_MS + KEEPALIVE_INTERVAL_MS);
    expect(rotationLog?.pendingBytes).toBeGreaterThanOrEqual(0);
    expect(errorLogs).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);

    await expect(drained).resolves.toContain(": max-age rotation, reconnect\n\n");
  });

  it("does not rotate an in-flight POST response past max age", async () => {
    const { response, ws } = await openPostSse();
    const drained = drainResponse(response);

    emitAgentEvent(ws, `event: message\ndata: {"jsonrpc":"2.0","id":1,"result":{}}\n\n`);
    await vi.advanceTimersByTimeAsync(MAX_SSE_AGE_MS + KEEPALIVE_INTERVAL_MS * 4);
    await flushMicrotasks();

    expect(ws.closeCode).toBeUndefined();
    expect(ws.closeReason).toBeUndefined();
    expect(rotationLogs(infoLogs)).toEqual([]);

    emitAgentEvent(
      ws,
      `event: message\ndata: {"jsonrpc":"2.0","id":1,"result":{"ok":true}}\n\n`,
      true,
    );
    await drained;

    expect(ws.closeCode).toBeUndefined();
    expect(ws.closeReason).toBeUndefined();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("leaves an SSE connection younger than max age untouched", async () => {
    const { response, ws } = await openSse();
    const drained = drainResponse(response);

    await vi.advanceTimersByTimeAsync(MAX_SSE_AGE_MS - KEEPALIVE_INTERVAL_MS * 2);
    await flushMicrotasks();

    expect(ws.closeCode).toBeUndefined();
    expect(rotationLogs(infoLogs)).toEqual([]);

    emitClose(ws);
    await drained;
    expect(vi.getTimerCount()).toBe(0);
  });

  it("still closes a stalled SSE writer at the byte cap without logging rotation", async () => {
    const stalledFrame = `event: message\ndata: ${"x".repeat(2 * 1024 * 1024)}\n\n`;
    const transform = installStallingTransformStream();
    const { ws } = await openSse();

    emitAgentEvent(ws, stalledFrame);
    await transform.stalledWrite;
    expect(transform.writeCount()).toBe(1);

    const stalledFrameBytes = encoder.encode(stalledFrame).byteLength;
    expect(stalledFrameBytes).toBeLessThan(MAX_PENDING_SSE_BYTES);

    for (let attempt = 0; attempt < 8 && ws.closeCode === undefined; attempt += 1) {
      emitAgentEvent(ws, stalledFrame);
    }

    expect(ws.closeCode).toBe(1013);
    expect(ws.closeReason).toBe("SSE client not draining");
    expect(transform.abortReason()).toBeInstanceOf(Error);
    expect(rotationLogs(infoLogs)).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("cleans up timers when the client closes before max age", async () => {
    const { response, ws } = await openSse();
    const drained = drainResponse(response);

    await vi.advanceTimersByTimeAsync(KEEPALIVE_INTERVAL_MS);
    emitClose(ws);
    await drained;

    expect(ws.closeCode).toBeUndefined();
    expect(rotationLogs(infoLogs)).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  });
});
