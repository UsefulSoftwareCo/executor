/**
 * An event stream ends with the request it answers.
 *
 * The product runs in a Durable Object. When a client disconnects, workerd never cancels the body
 * stream the object returned: it stops reading the stream once its own buffers fill, and the
 * stream's producer keeps running for as long as the object does. Each live app query that a page
 * ever opened kept re-running every 15 seconds until the process restarted, and each MCP stream
 * kept its session's work. With the `enable_request_signal` compatibility flag, workerd aborts the
 * request's signal once it cannot deliver the response to a client that has gone, which it finds
 * on the next write, so an event stream here ends on that signal.
 *
 * Only event streams run until they are cancelled; every other body, such as a rendered page, a
 * dashboard file or a batch of reads, ends on its own. Those pass through untouched: ending a body
 * on a signal merges it with the wait, which hands each chunk between fibers, and on workerd's one
 * JavaScript thread a page streamed in many chunks then waited for other work, such as the
 * Executor app's build after setup, once per chunk.
 */
import { Effect, Stream } from "effect";
import { HttpBody, type HttpServerRequest, HttpServerResponse } from "effect/http";

/** Completes when `signal` aborts. */
const aborted = (signal: AbortSignal) =>
  Effect.callback<void>((resume) => {
    if (signal.aborted) return resume(Effect.void);
    const abort = () => resume(Effect.void);
    signal.addEventListener("abort", abort, { once: true });
    return Effect.sync(() => signal.removeEventListener("abort", abort));
  });

const declaredLength = (value: string | undefined) =>
  value !== undefined && /^\d+$/.test(value) ? Number(value) : undefined;

/**
 * `response`, with an event stream body that stops when workerd aborts `request`. `setBody`
 * rewrites `content-type` and `content-length` from the body, so the body carries the response's
 * own.
 */
export const endsWithRequest = (
  request: HttpServerRequest.HttpServerRequest,
  response: HttpServerResponse.HttpServerResponse,
) => {
  const body = response.body;
  if (!(body instanceof HttpBody.Stream) || !(request.source instanceof Request)) return response;
  const contentType = response.headers["content-type"] ?? body.contentType;
  if (contentType.split(";")[0]?.trim().toLowerCase() !== "text/event-stream") return response;
  return HttpServerResponse.setBody(
    response,
    HttpBody.stream(
      body.stream.pipe(Stream.interruptWhen(aborted(request.source.signal))),
      contentType,
      declaredLength(response.headers["content-length"]) ?? body.contentLength,
    ),
  );
};
