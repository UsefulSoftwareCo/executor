import { Effect, Stream } from "effect";
import { HttpBody, type HttpServerRequest, HttpServerResponse } from "effect/http";

const aborted = (signal: AbortSignal) =>
  Effect.callback<void>((resume) => {
    if (signal.aborted) return resume(Effect.void);
    const abort = () => resume(Effect.void);
    signal.addEventListener("abort", abort, { once: true });
    return Effect.sync(() => signal.removeEventListener("abort", abort));
  });

const declaredLength = (value: string | undefined) =>
  value !== undefined && /^\d+$/.test(value) ? Number(value) : undefined;

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
