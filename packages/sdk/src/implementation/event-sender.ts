/**
 * Event requests over a host's checked egress client. The destination is checked against the
 * host's URL policy before each request; redirects are never followed, and a response body is
 * read only up to a small bound, since only a verification echo needs it.
 */
import { Effect, Stream } from "effect";
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/http";
import { parseDestination, type HostEgress } from "@executor-js/utils/url-policy";
import { EventCallbackFailed, type EventSender } from "../contracts/events.ts";

/** A verification echo is a small JSON object; nothing larger is read. */
const maxResponseBytes = 16 * 1024;

export const httpEventSender = (egress: HostEgress): EventSender => ({
  send: (request, timeoutMs, { readBody }) =>
    Effect.gen(function* () {
      const url = parseDestination(request.url, egress.policy);
      if (url === undefined)
        return yield* new EventCallbackFailed({ reason: "connection_refused" });
      // The request belongs to this scope: closing it aborts a body nobody reads.
      const response = yield* HttpClient.withScope(egress.client).execute(
        HttpClientRequest.post(url.href).pipe(
          HttpClientRequest.setHeaders(request.headers),
          HttpClientRequest.bodyText(request.body, "application/json"),
        ),
      );
      if (!readBody) return { status: response.status, body: "" };
      let size = 0;
      const chunks: Uint8Array[] = [];
      yield* response.stream.pipe(
        Stream.takeWhile((chunk) => {
          size += chunk.byteLength;
          if (size <= maxResponseBytes) chunks.push(chunk);
          return size <= maxResponseBytes;
        }),
        Stream.runDrain,
      );
      const bytes = new Uint8Array(chunks.reduce((total, chunk) => total + chunk.byteLength, 0));
      let offset = 0;
      for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.byteLength;
      }
      return { status: response.status, body: new TextDecoder().decode(bytes) };
    }).pipe(
      Effect.scoped,
      Effect.provideService(FetchHttpClient.RequestInit, { redirect: "manual" }),
      Effect.timeout(timeoutMs),
      Effect.catchTag("TimeoutError", () =>
        Effect.fail(new EventCallbackFailed({ reason: "timeout" })),
      ),
      Effect.catchTag("HttpClientError", () =>
        Effect.fail(new EventCallbackFailed({ reason: "connection_refused" })),
      ),
    ),
});
