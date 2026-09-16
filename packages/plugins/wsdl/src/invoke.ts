import { Effect, Stream } from "effect";
import { HttpClient, HttpClientRequest } from "effect/unstable/http";
import type { WsdlOperation } from "./contract";
import { decodeEnvelope, encodeElement } from "./codec";
import { ENVELOPE, WsdlError } from "./xml";

export const invoke = (
  operation: WsdlOperation,
  args: unknown,
  endpoint: string,
  headers: Readonly<Record<string, string>> = {},
) =>
  Effect.gen(function* () {
    const url = yield* Effect.try({
      try: () => new URL(endpoint),
      catch: () => new WsdlError({ message: "Invalid SOAP endpoint" }),
    });
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.hash)
      return yield* new WsdlError({
        message: "SOAP endpoint must be HTTP(S) without credentials or fragment",
      });
    if (/["\r\n]/.test(operation.action))
      return yield* new WsdlError({ message: "Invalid SOAPAction" });
    const body = yield* encodeElement(operation.input, args);
    if (new TextEncoder().encode(body).byteLength > 2_000_000)
      return yield* new WsdlError({ message: "SOAP request exceeds 2 MB" });
    const client = yield* HttpClient.HttpClient;
    const request = HttpClientRequest.post(endpoint).pipe(
      HttpClientRequest.setHeaders(headers),
      HttpClientRequest.bodyText(
        `<soap:Envelope xmlns:soap="${ENVELOPE}"><soap:Body>${body}</soap:Body></soap:Envelope>`,
        "text/xml; charset=utf-8",
      ),
      HttpClientRequest.setHeader("SOAPAction", `"${operation.action}"`),
    );
    const response = yield* client
      .execute(request)
      .pipe(Effect.mapError(() => new WsdlError({ message: "SOAP HTTP request failed" })));
    const decoder = new TextDecoder("utf-8", { fatal: true });
    const collected = yield* response.stream.pipe(
      Stream.runFoldEffect(
        () => ({ bytes: 0, text: "" }),
        (state, chunk) => {
          const bytes = state.bytes + chunk.byteLength;
          return bytes > 2_000_000
            ? Effect.fail(new WsdlError({ message: "SOAP response exceeds 2 MB" }))
            : Effect.try({
                try: () => ({ bytes, text: state.text + decoder.decode(chunk, { stream: true }) }),
                catch: () => new WsdlError({ message: "SOAP response must be valid UTF-8" }),
              });
        },
      ),
      Effect.mapError(
        () => new WsdlError({ message: "Unable to read SOAP response or response exceeds 2 MB" }),
      ),
    );
    const text = yield* Effect.try({
      try: () => collected.text + decoder.decode(),
      catch: () => new WsdlError({ message: "SOAP response must be valid UTF-8" }),
    });
    const decoded = yield* decodeEnvelope(operation.output, text);
    if (decoded.ok && (response.status < 200 || response.status >= 300))
      return yield* new WsdlError({
        message: `SOAP HTTP request failed with status ${response.status}`,
      });
    return decoded;
  }).pipe(
    Effect.timeoutOrElse({
      duration: "110 seconds",
      orElse: () => Effect.fail(new WsdlError({ message: "SOAP request timed out" })),
    }),
  );
