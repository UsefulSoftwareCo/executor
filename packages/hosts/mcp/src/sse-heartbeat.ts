// SSE comment heartbeats for quiet standalone GET `/mcp` streams.
//
// The SDK's GET handler returns `200 text/event-stream` and stores the
// controller without writing bytes until a server-initiated message exists.
// Bun fetch (and some intermediaries) wait for the first body byte and then
// time out a silent stream. `idleTimeout: 0` on Bun.serve does not emit those
// bytes. A comment frame is legal SSE, ignored by the MCP parser, and does not
// carry an event id.

/** SSE comment frame the MCP parser drops before any event dispatch. */
export const MCP_SSE_KEEPALIVE_FRAME = ": keepalive\n\n";

/** Same interval the Cloudflare agents bridge already uses. */
export const MCP_SSE_KEEPALIVE_INTERVAL_MS = 25_000;

const encoder = new TextEncoder();
const keepaliveBytes = encoder.encode(MCP_SSE_KEEPALIVE_FRAME);

const isSuccessfulSseGet = (request: Request, response: Response): boolean =>
  request.method === "GET" &&
  response.status === 200 &&
  (response.headers.get("content-type") ?? "").includes("text/event-stream") &&
  response.body !== null;

/**
 * Wrap a successful GET `text/event-stream` response with an immediate SSE
 * comment and a repeating comment on {@link MCP_SSE_KEEPALIVE_INTERVAL_MS}.
 * Non-GET, non-SSE, and error responses are returned unchanged.
 */
export const withMcpSseHeartbeat = (request: Request, response: Response): Response => {
  if (!isSuccessfulSseGet(request, response) || response.body === null) return response;

  const upstream = response.body;
  let timer: ReturnType<typeof setInterval> | undefined;
  let reader:
    | {
        read: () => Promise<{ done: boolean; value?: Uint8Array }>;
        cancel: (reason?: unknown) => Promise<void>;
      }
    | undefined;
  let cancelled = false;

  const stopTimer = (): void => {
    if (timer === undefined) return;
    clearInterval(timer);
    timer = undefined;
  };

  const body = new ReadableStream<Uint8Array>({
    async start(controller) {
      const writeKeepalive = (): void => {
        // oxlint-disable-next-line executor/no-try-catch-or-throw -- boundary: enqueue throws after cancel/close
        try {
          controller.enqueue(keepaliveBytes);
        } catch {
          stopTimer();
        }
      };

      writeKeepalive();
      timer = setInterval(writeKeepalive, MCP_SSE_KEEPALIVE_INTERVAL_MS);
      (timer as { unref?: () => void }).unref?.();

      if (cancelled) {
        stopTimer();
        await upstream.cancel();
        return;
      }

      reader = upstream.getReader();
      // oxlint-disable-next-line executor/no-try-catch-or-throw -- boundary: upstream read/close must not leak the interval
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done || cancelled) break;
          if (value !== undefined) controller.enqueue(value);
        }
        if (!cancelled) controller.close();
      } catch (error) {
        if (!cancelled) controller.error(error);
      } finally {
        stopTimer();
      }
    },
    async cancel(reason) {
      cancelled = true;
      stopTimer();
      if (reader !== undefined) {
        await reader.cancel(reason);
        return;
      }
      await upstream.cancel(reason);
    },
  });

  return new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers: new Headers(response.headers),
  });
};
