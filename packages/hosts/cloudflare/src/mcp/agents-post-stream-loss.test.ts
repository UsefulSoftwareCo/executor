// Unit coverage for the POST bridge's lost-execution handling (see
// patches/agents@0.17.3.patch).
//
// The front worker answers a POST with HTTP 200 and an SSE body long before the
// Durable Object produces a result. When the DO is reset mid-execute (isolate
// memory/CPU limit, storage timeout, deploy) the bridge WebSocket closes, and
// the bridge used to simply close the writer: the client saw a cleanly
// terminated SSE stream carrying no JSON-RPC response, which is
// indistinguishable from "still working" until its own timeout fires. Same
// outcome if the DO never answers at all.
//
// Three properties are pinned here:
//   1. An abnormal WS close answers everything still outstanding with the
//      -32010 session_reset error, then ends the stream.
//   2. The happy path is byte-identical — a delivered response leaves nothing
//      outstanding, so nothing is synthesized.
//   3. The response deadline answers a stream the DO never replied on, and the
//      constant that bounds it still clears the two source constants it has to
//      track (it lives in a vendored dist and cannot import them).
import { readFileSync } from "node:fs";

import { afterEach, beforeEach, describe, expect, it, vi } from "@effect/vitest";
import { MCP_POST_RESPONSE_DEADLINE_MS, McpAgent } from "agents/mcp";
import { Effect, Option, Schema } from "effect";

import { PAUSED_APPROVAL_TIMEOUT_MS } from "@executor-js/host-mcp/tool-server";

const SESSION_RESET_ERROR_CODE = -32010;
/** Margin the patch adds on top of the two bounded waits. */
const DEADLINE_MARGIN_MS = 60_000;

type FakeWebSocket = EventTarget & {
  accepted: boolean;
  closeCode: number | undefined;
  closeReason: string | undefined;
  accept: () => void;
  close: (code?: number, reason?: string) => void;
  send: (message: string) => void;
};

const JsonRpcErrorFrame = Schema.Struct({
  error: Schema.Struct({
    code: Schema.Number,
    data: Schema.Struct({ reason: Schema.String }),
    message: Schema.String,
  }),
  id: Schema.Union([Schema.String, Schema.Number]),
  jsonrpc: Schema.Literal("2.0"),
});
const decodeJsonRpcErrorFrame = Schema.decodeUnknownOption(
  Schema.fromJsonString(JsonRpcErrorFrame),
);

/** Every `data:` payload in an SSE body that parses as a JSON-RPC error. */
const errorFrames = (body: string): ReadonlyArray<typeof JsonRpcErrorFrame.Type> =>
  body.split("\n").flatMap((line) => {
    if (!line.startsWith("data: ")) return [];
    const decoded = decodeJsonRpcErrorFrame(line.slice("data: ".length));
    return Option.isSome(decoded) ? [decoded.value] : [];
  });

const flushMicrotasks = async (): Promise<void> => {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
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
  ws.send = () => {};
  return ws;
};

const makeNamespace = (ws: FakeWebSocket) => ({
  newUniqueId: () => ({ toString: () => "generated-session" }),
  idFromName: (name: string) => ({ equals: () => true, name, toString: () => name }),
  get: () => ({
    setName: async () => {},
    getInitializeRequest: async () => ({}),
    fetch: async () => ({ webSocket: ws }),
  }),
});

const postToBridge = async (body: unknown) => {
  const ws = makeWebSocket();
  const handler = McpAgent.serve("/mcp", {
    binding: "MCP_SESSION",
    transport: "streamable-http",
  });
  const response = await handler.fetch(
    new Request("https://executor.sh/mcp", {
      body: JSON.stringify(body),
      headers: {
        accept: "application/json, text/event-stream",
        "content-type": "application/json",
        "mcp-session-id": "session-1",
      },
      method: "POST",
    }),
    { MCP_SESSION: makeNamespace(ws) },
    makeExecutionContext(),
  );
  return { response, ws };
};

const toolCall = (id: number | string) => ({
  id,
  jsonrpc: "2.0" as const,
  method: "tools/call",
  params: { arguments: {}, name: "execute" },
});

/**
 * Deliver one `cf_mcp_agent_event` envelope exactly as the patched
 * `writeSSEEvent` builds it, including the `respondedIds` field the bridge uses
 * to retire outstanding ids.
 */
const emitResponse = (ws: FakeWebSocket, message: { readonly id: number | string }, close = true) =>
  ws.dispatchEvent(
    new MessageEvent("message", {
      data: JSON.stringify({
        close: close ? true : undefined,
        event: `event: message\ndata: ${JSON.stringify(message)}\n\n`,
        respondedIds: [message.id],
        type: "cf_mcp_agent_event",
      }),
    }),
  );

/**
 * A Durable Object reset closes the bridge socket with no close code at all —
 * `CloseEvent` is not reliably constructible across runtimes, so the shape the
 * handler actually reads (`code` / `reason`) is attached directly.
 */
const emitAbnormalClose = (ws: FakeWebSocket, code?: number, reason?: string) =>
  ws.dispatchEvent(Object.assign(new Event("close"), { code, reason }));

describe("POST bridge: lost-execution visibility", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("answers every outstanding request when the bridge socket closes abnormally", async () => {
    const { response, ws } = await postToBridge([toolCall(1), toolCall("two")]);
    const drained = drainResponse(response);

    emitAbnormalClose(ws);
    const body = await drained;

    const frames = errorFrames(body);
    expect(
      frames.map((frame) => frame.id),
      "one error per unanswered request id, preserving the id's JSON type",
    ).toEqual([1, "two"]);
    for (const frame of frames) {
      expect(frame.error.code).toBe(SESSION_RESET_ERROR_CODE);
      expect(frame.error.data.reason).toBe("session_reset");
      expect(frame.error.message).toContain("Execution lost");
    }
  });

  it("writes nothing extra when the response was delivered before the close", async () => {
    const { response, ws } = await postToBridge(toolCall(1));
    const drained = drainResponse(response);

    const result = { id: 1, jsonrpc: "2.0" as const, result: { ok: true } };
    emitResponse(ws, result);
    await flushMicrotasks();
    emitAbnormalClose(ws);
    const body = await drained;

    expect(body, "the delivered result is the only frame on the wire").toBe(
      `event: message\ndata: ${JSON.stringify(result)}\n\n`,
    );
    expect(errorFrames(body)).toEqual([]);
    expect(ws.closeCode, "the happy-path close is unchanged").toBe(1000);
    expect(ws.closeReason).toBe("SSE response delivered");
  });

  it("answers the request itself when the DO never responds before the deadline", async () => {
    const { response, ws } = await postToBridge(toolCall(7));
    const drained = drainResponse(response);

    await vi.advanceTimersByTimeAsync(MCP_POST_RESPONSE_DEADLINE_MS - 1);
    expect(errorFrames(await Promise.race([drained, Promise.resolve("")]))).toEqual([]);

    await vi.advanceTimersByTimeAsync(2);
    const body = await drained;

    const frames = errorFrames(body);
    expect(frames.map((frame) => frame.id)).toEqual([7]);
    expect(frames[0]?.error.code).toBe(SESSION_RESET_ERROR_CODE);
    expect(frames[0]?.error.data.reason).toBe("response_deadline");
    expect(vi.getTimerCount(), "the deadline and the keepalive are both disarmed").toBe(0);

    // A close arriving after the bridge already answered must not double-write.
    emitAbnormalClose(ws);
    await flushMicrotasks();
    expect(errorFrames(body).length).toBe(1);
  });

  it("arms no deadline for a body that owes no response", async () => {
    const { response } = await postToBridge({
      jsonrpc: "2.0",
      method: "notifications/initialized",
    });

    expect(response.status).toBe(202);
    expect(vi.getTimerCount(), "a notifications-only POST leaves no timer behind").toBe(0);
  });
});

describe("POST response deadline: drift against the waits it must cover", () => {
  /**
   * Evaluate the small `a * b + c` expressions these constants are declared
   * with. Anything outside digits, `_`, `*`, `+` and the named substitutions is
   * refused, so a declaration that grows a new shape fails the test loudly
   * instead of silently reading as `NaN`.
   */
  const evaluate = (expression: string, known: Readonly<Record<string, number>>): number | null => {
    let total = 0;
    for (const term of expression.split("+")) {
      let product = 1;
      for (const rawFactor of term.split("*")) {
        const factor = rawFactor.trim();
        const named = known[factor];
        if (named !== undefined) {
          product *= named;
          continue;
        }
        if (!/^\d[\d_]*$/.test(factor)) return null;
        product *= Number(factor.replaceAll("_", ""));
      }
      total += product;
    }
    return total;
  };

  /**
   * Read a constant out of another package's source. Deliberately a file read
   * and not an import: `DEFAULT_TIMEOUT_MS` is private to the dynamic-worker
   * runtime, the bridge constant that has to cover it lives in a vendored dist
   * that can import neither, and this test exists precisely to notice when the
   * two drift apart.
   */
  const readConstant = (
    relativePath: string,
    name: string,
    known: Readonly<Record<string, number>> = {},
  ): number | null => {
    const source = readFileSync(new URL(relativePath, import.meta.url), "utf8");
    const match = new RegExp(`\\b${name}\\s*=\\s*([^;\\n]+);`).exec(source);
    return match?.[1] === undefined ? null : evaluate(match[1], known);
  };

  const RUNTIME_EXECUTOR = "../../../../kernel/runtime-dynamic-worker/src/executor.ts";
  const TOOL_SERVER = "../../../mcp/src/tool-server.ts";

  it("covers the sandbox execution ceiling plus the browser-approval wait plus margin", () => {
    const sandboxTimeoutMs = readConstant(RUNTIME_EXECUTOR, "DEFAULT_TIMEOUT_MS");
    expect(sandboxTimeoutMs, `DEFAULT_TIMEOUT_MS not readable from ${RUNTIME_EXECUTOR}`).not.toBe(
      null,
    );

    // The scrape is kept honest by the one constant that IS a public export:
    // if the regex ever stops reading these declarations correctly, this
    // mismatch fires rather than the test passing on a wrong number.
    const scrapedPausedApprovalMs = readConstant(TOOL_SERVER, "PAUSED_APPROVAL_TIMEOUT_MS");
    expect(scrapedPausedApprovalMs, "scraped value must match the real export").toBe(
      PAUSED_APPROVAL_TIMEOUT_MS,
    );

    const browserApprovalWaitMs = readConstant(TOOL_SERVER, "BROWSER_APPROVAL_WAIT_TIMEOUT_MS", {
      PAUSED_APPROVAL_TIMEOUT_MS,
    });
    expect(
      browserApprovalWaitMs,
      `BROWSER_APPROVAL_WAIT_TIMEOUT_MS not readable from ${TOOL_SERVER}`,
    ).not.toBe(null);

    const required = (sandboxTimeoutMs ?? 0) + (browserApprovalWaitMs ?? 0) + DEADLINE_MARGIN_MS;
    expect(
      MCP_POST_RESPONSE_DEADLINE_MS,
      "the bridge would answer for a call that is still legitimately running — raise " +
        "MCP_POST_RESPONSE_DEADLINE_MS in patches/agents@0.17.3.patch",
    ).toBeGreaterThanOrEqual(required);
  });
});
