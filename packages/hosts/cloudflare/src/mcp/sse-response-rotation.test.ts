import { afterEach, beforeEach, describe, expect, it, vi } from "@effect/vitest";

import { SESSION_TIMEOUT_MS, SSE_MAX_AGE_MS } from "./session-alarm-policy";
import {
  SSE_MAX_AGE_RECONNECT_FRAME,
  rotateSseResponse,
  type SseResponseCloseReason,
} from "./sse-response-rotation";

const sseResponse = (cancelled: { value: boolean }): Response =>
  new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(": keepalive\n\n"));
      },
      cancel() {
        cancelled.value = true;
      },
    }),
    { headers: { "content-type": "text/event-stream", "content-length": "100" } },
  );

describe("rotateSseResponse", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("keeps the production max age well above the session idle timeout", () => {
    expect(SSE_MAX_AGE_MS).toBe(30 * 60 * 1000);
    expect(SSE_MAX_AGE_MS).toBeGreaterThanOrEqual(6 * SESSION_TIMEOUT_MS);
  });

  it("closes any still-open SSE response with a reconnect comment at max age", async () => {
    const cancelled = { value: false };
    const closes: SseResponseCloseReason[] = [];
    const response = rotateSseResponse(sseResponse(cancelled), {
      maxAgeMs: 1_000,
      onClose: (reason) => closes.push(reason),
    });
    const bodyPromise = response.text();

    await vi.advanceTimersByTimeAsync(1_000);

    await expect(bodyPromise).resolves.toBe(`: keepalive\n\n${SSE_MAX_AGE_RECONNECT_FRAME}`);
    expect(cancelled.value).toBe(true);
    expect(closes).toEqual(["rotate"]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("prepends a compatibility frame before SDK stream bytes", async () => {
    const source = new Response("event: message\ndata: {}\n\n", {
      headers: { "content-type": "text/event-stream" },
    });
    const response = rotateSseResponse(source, {
      maxAgeMs: 1_000,
      initialFrame: new TextEncoder().encode("event: mcp-priming\nid: stream:1\ndata: {}\n\n"),
    });

    await expect(response.text()).resolves.toBe(
      "event: mcp-priming\nid: stream:1\ndata: {}\n\nevent: message\ndata: {}\n\n",
    );
    expect(vi.getTimerCount()).toBe(0);
  });

  it("cancels the max-age timer when the client closes first", async () => {
    const cancelled = { value: false };
    const closes: SseResponseCloseReason[] = [];
    const response = rotateSseResponse(sseResponse(cancelled), {
      maxAgeMs: 1_000,
      onClose: (reason) => closes.push(reason),
    });
    const reader = response.body?.getReader();
    await reader?.read();
    await reader?.cancel();

    await vi.advanceTimersByTimeAsync(1_000);

    expect(cancelled.value).toBe(true);
    expect(closes).toEqual(["cancel"]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("leaves non-SSE responses unchanged", () => {
    const response = new Response("ok", { headers: { "content-type": "application/json" } });
    expect(rotateSseResponse(response)).toBe(response);
  });
});
