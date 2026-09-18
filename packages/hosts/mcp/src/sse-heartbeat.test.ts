import { afterEach, describe, expect, it, vi } from "@effect/vitest";

import {
  MCP_SSE_KEEPALIVE_FRAME,
  MCP_SSE_KEEPALIVE_INTERVAL_MS,
  withMcpSseHeartbeat,
} from "./sse-heartbeat";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

const sseGet = (): Request =>
  new Request("https://executor.test/mcp", {
    method: "GET",
    headers: { accept: "text/event-stream", "mcp-session-id": "s1" },
  });

const sseResponse = (
  body: ReadableStream<Uint8Array> | string,
  headers: Record<string, string> = { "content-type": "text/event-stream", "mcp-session-id": "s1" },
): Response => new Response(body, { status: 200, statusText: "OK", headers });

const pendingStream = (): {
  readonly stream: ReadableStream<Uint8Array>;
  readonly push: (chunk: string) => void;
  readonly close: () => void;
  readonly error: (cause: unknown) => void;
  readonly cancelled: () => boolean;
  readonly cancelReason: () => unknown;
} => {
  let cancelled = false;
  let cancelReason: unknown;
  let controller: ReadableStreamDefaultController<Uint8Array>;
  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      controller = c;
    },
    cancel(reason) {
      cancelled = true;
      cancelReason = reason;
    },
  });
  return {
    stream,
    push: (chunk) => controller.enqueue(encoder.encode(chunk)),
    close: () => controller.close(),
    error: (cause) => controller.error(cause),
    cancelled: () => cancelled,
    cancelReason: () => cancelReason,
  };
};

const readChunk = async (reader: {
  read: () => Promise<{ done: boolean; value?: Uint8Array }>;
}): Promise<string> => {
  const { value, done } = await reader.read();
  expect(done).toBe(false);
  return decoder.decode(value);
};

afterEach(() => {
  vi.useRealTimers();
});

describe("withMcpSseHeartbeat", () => {
  it("returns non-GET responses unchanged", () => {
    const request = new Request("https://executor.test/mcp", { method: "POST" });
    const response = sseResponse("data: x\n\n");
    expect(withMcpSseHeartbeat(request, response)).toBe(response);
  });

  it("returns non-SSE GET responses unchanged", () => {
    const response = new Response("{}", {
      status: 200,
      headers: { "content-type": "application/json" },
    });
    expect(withMcpSseHeartbeat(sseGet(), response)).toBe(response);
  });

  it("returns error GET SSE responses unchanged", () => {
    const response = new Response("nope", {
      status: 409,
      headers: { "content-type": "text/event-stream" },
    });
    expect(withMcpSseHeartbeat(sseGet(), response)).toBe(response);
  });

  it("emits the keepalive comment as the first body bytes", async () => {
    const upstream = pendingStream();
    const wrapped = withMcpSseHeartbeat(sseGet(), sseResponse(upstream.stream));
    const reader = wrapped.body!.getReader();
    expect(await readChunk(reader)).toBe(MCP_SSE_KEEPALIVE_FRAME);
    await reader.cancel();
  });

  it("repeats the keepalive comment on the established interval", async () => {
    vi.useFakeTimers();
    const upstream = pendingStream();
    const wrapped = withMcpSseHeartbeat(sseGet(), sseResponse(upstream.stream));
    const reader = wrapped.body!.getReader();
    expect(await readChunk(reader)).toBe(MCP_SSE_KEEPALIVE_FRAME);
    const next = readChunk(reader);
    await vi.advanceTimersByTimeAsync(MCP_SSE_KEEPALIVE_INTERVAL_MS);
    expect(await next).toBe(MCP_SSE_KEEPALIVE_FRAME);
    await reader.cancel();
  });

  it("forwards original SSE bytes unchanged and in order after the comment", async () => {
    const upstream = pendingStream();
    const wrapped = withMcpSseHeartbeat(sseGet(), sseResponse(upstream.stream));
    const reader = wrapped.body!.getReader();
    expect(await readChunk(reader)).toBe(MCP_SSE_KEEPALIVE_FRAME);
    upstream.push('id: 1\ndata: {"jsonrpc":"2.0"}\n\n');
    expect(await readChunk(reader)).toBe('id: 1\ndata: {"jsonrpc":"2.0"}\n\n');
    upstream.push("data: two\n\n");
    expect(await readChunk(reader)).toBe("data: two\n\n");
    await reader.cancel();
  });

  it("preserves status, status text, and every response header", () => {
    const headers = {
      "content-type": "text/event-stream",
      "mcp-session-id": "sess-9",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "access-control-allow-origin": "*",
      "access-control-expose-headers": "mcp-session-id",
    };
    const wrapped = withMcpSseHeartbeat(sseGet(), sseResponse(pendingStream().stream, headers));
    expect(wrapped.status).toBe(200);
    expect(wrapped.statusText).toBe("OK");
    for (const [key, value] of Object.entries(headers)) {
      expect(wrapped.headers.get(key)).toBe(value);
    }
  });

  it("does not stamp an event id on the keepalive comment", async () => {
    const wrapped = withMcpSseHeartbeat(sseGet(), sseResponse(pendingStream().stream));
    const reader = wrapped.body!.getReader();
    const first = await readChunk(reader);
    expect(first.startsWith(": ")).toBe(true);
    expect(first).not.toContain("id:");
    expect(first).not.toContain("data:");
    await reader.cancel();
  });

  it("cancels the upstream body when the wrapped body is cancelled", async () => {
    const upstream = pendingStream();
    const wrapped = withMcpSseHeartbeat(sseGet(), sseResponse(upstream.stream));
    const reader = wrapped.body!.getReader();
    await readChunk(reader);
    await reader.cancel("client-gone");
    expect(upstream.cancelled()).toBe(true);
    expect(upstream.cancelReason()).toBe("client-gone");
  });

  it("clears the timer after cancel, completion, and error", async () => {
    vi.useFakeTimers();

    const cancelled = pendingStream();
    const cancelledWrap = withMcpSseHeartbeat(sseGet(), sseResponse(cancelled.stream));
    const cancelledReader = cancelledWrap.body!.getReader();
    await readChunk(cancelledReader);
    expect(vi.getTimerCount()).toBeGreaterThan(0);
    await cancelledReader.cancel();
    expect(vi.getTimerCount()).toBe(0);

    const completed = pendingStream();
    const completedWrap = withMcpSseHeartbeat(sseGet(), sseResponse(completed.stream));
    const completedReader = completedWrap.body!.getReader();
    await readChunk(completedReader);
    completed.close();
    await completedReader.read();
    expect(vi.getTimerCount()).toBe(0);

    const failed = pendingStream();
    const failedWrap = withMcpSseHeartbeat(sseGet(), sseResponse(failed.stream));
    const failedReader = failedWrap.body!.getReader();
    await readChunk(failedReader);
    failed.error("upstream closed");
    // oxlint-disable-next-line executor/no-try-catch-or-throw -- test boundary: drain the errored reader
    try {
      await failedReader.read();
    } catch {
      // expected: upstream error surfaces on the wrapped reader
    }
    expect(vi.getTimerCount()).toBe(0);
  });
});
