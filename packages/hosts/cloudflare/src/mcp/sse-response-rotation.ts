import { SSE_MAX_AGE_MS } from "./session-alarm-policy";

/** Comment emitted immediately before a max-age close asks clients to resume. */
export const SSE_MAX_AGE_RECONNECT_FRAME = ": max-age rotation, reconnect\n\n";

export type SseResponseCloseReason = "cancel" | "complete" | "error" | "rotate";

export interface SseResponseRotationOptions {
  readonly maxAgeMs?: number;
  readonly initialFrame?: Uint8Array;
  readonly onOpen?: () => void;
  readonly onClose?: (reason: SseResponseCloseReason) => void;
}

const isSseResponse = (response: Response): boolean =>
  response.body !== null &&
  (response.headers.get("content-type") ?? "").includes("text/event-stream");

/**
 * Bound one streamed response's lifetime and preserve direct response
 * streaming. Rotation emits a benign comment, closes this HTTP body, and
 * cancels the SDK body so its stream bookkeeping is released; the event store
 * supplies any later replay to the client's reconnect GET.
 */
export const rotateSseResponse = (
  response: Response,
  options: SseResponseRotationOptions = {},
): Response => {
  if (!isSseResponse(response) || !response.body) return response;

  const reader = response.body.getReader();
  const reconnectFrame = new TextEncoder().encode(SSE_MAX_AGE_RECONNECT_FRAME);
  const maxAgeMs = options.maxAgeMs ?? SSE_MAX_AGE_MS;
  let controller: ReadableStreamDefaultController<Uint8Array>;
  let closed = false;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const finish = (reason: SseResponseCloseReason): void => {
    if (closed) return;
    closed = true;
    if (timer !== undefined) clearTimeout(timer);
    if (reason === "rotate") {
      controller.enqueue(reconnectFrame);
      controller.close();
      void reader.cancel("mcp_sse_max_age_rotation").then(
        () => undefined,
        () => undefined,
      );
    } else if (reason === "complete") {
      controller.close();
    }
    options.onClose?.(reason);
  };

  const body = new ReadableStream<Uint8Array>({
    start(streamController) {
      controller = streamController;
      options.onOpen?.();
      if (options.initialFrame) controller.enqueue(options.initialFrame);
      timer = setTimeout(() => finish("rotate"), maxAgeMs);
    },
    async pull() {
      // oxlint-disable-next-line executor/no-try-catch-or-throw -- stream boundary: propagate the source body's rejected read to the response consumer
      try {
        const next = await reader.read();
        if (closed) return;
        if (next.done) {
          finish("complete");
          return;
        }
        controller.enqueue(next.value);
      } catch (cause) {
        if (closed) return;
        closed = true;
        if (timer !== undefined) clearTimeout(timer);
        options.onClose?.("error");
        controller.error(cause);
      }
    },
    async cancel(reason) {
      if (!closed) {
        closed = true;
        if (timer !== undefined) clearTimeout(timer);
        options.onClose?.("cancel");
      }
      await reader.cancel(reason);
    },
  });

  const headers = new Headers(response.headers);
  headers.delete("content-length");
  return new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
};
