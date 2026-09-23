/** Same-origin browser error delivery, restricted to this stage's managed Sentry project. */
import { SentryTransportFailed } from "./error-reporting.ts";
import { CurrentRuntimeContext } from "alchemy/RuntimeContext";
import { ByteSize, Effect, Option, Schema } from "effect";
import { HttpIncomingMessage, HttpServerRequest, HttpServerResponse } from "effect/unstable/http";

const Settings = Schema.Struct({
  localTest: Schema.optional(Schema.Literal(true)),
  browserDsn: Schema.String,
  tunnel: Schema.String.check(Schema.isPattern(/^\/api\/[a-f0-9]{16}\/submit$/)),
});
const Header = Schema.fromJsonString(Schema.Struct({ dsn: Schema.String }));

/** Validate the envelope's destination before deriving a fixed ingestion URL from configuration. */
export const sentryEnvelopeTarget = (
  body: string,
  expectedDsn: string,
  localTest = false,
): string | undefined => {
  const newline = body.indexOf("\n");
  if (newline < 0 || newline > 8192) return undefined;
  const header = Schema.decodeUnknownOption(Header)(body.slice(0, newline));
  if (Option.isNone(header) || header.value.dsn !== expectedDsn) return undefined;
  const dsn = new URL(expectedDsn);
  if (
    (dsn.protocol !== "https:" &&
      !(localTest && dsn.protocol === "http:" && dsn.hostname === "127.0.0.1")) ||
    !/^\/\d+$/.test(dsn.pathname)
  )
    return undefined;
  return `${dsn.origin}/api${dsn.pathname}/envelope/?sentry_version=7&sentry_key=${encodeURIComponent(dsn.username)}`;
};

/** Capture the native binding accessor during initialization and resolve it per request. */
export const cloudErrorTunnel = Effect.gen(function* () {
  const context = yield* CurrentRuntimeContext;
  return Effect.gen(function* () {
    const value = context ? yield* context.get<unknown>("EXECUTOR_SENTRY") : undefined;
    if (value === undefined || value === null) return HttpServerResponse.empty({ status: 404 });
    const config = yield* Schema.decodeUnknownEffect(Settings)(value).pipe(Effect.orDie);
    const request = yield* HttpServerRequest.HttpServerRequest;
    if (new URL(request.url, "https://sentry.internal").pathname !== config.tunnel)
      return HttpServerResponse.empty({ status: 404 });
    const body = yield* request.arrayBuffer.pipe(
      Effect.provideService(HttpIncomingMessage.MaxBodySize, ByteSize.kibibytes(1024)),
      Effect.option,
    );
    if (Option.isNone(body)) return HttpServerResponse.empty({ status: 413 });
    const bytes = new Uint8Array(body.value);
    const target = sentryEnvelopeTarget(
      new TextDecoder().decode(bytes.subarray(0, 8193)),
      config.browserDsn,
      config.localTest === true,
    );
    if (!target) return HttpServerResponse.empty({ status: 400 });
    const response = yield* Effect.tryPromise({
      try: async (signal) => {
        const response = await fetch(target, {
          method: "POST",
          signal,
          body: bytes,
          headers: { "content-type": "application/x-sentry-envelope" },
          redirect: "manual",
        });
        if (response.status >= 300 && response.status < 400) throw new SentryTransportFailed();
        const headers: Record<string, string> = {};
        for (const name of ["x-sentry-rate-limits", "retry-after"]) {
          const value = response.headers.get(name);
          if (value !== null) headers[name] = value;
        }
        await response.arrayBuffer();
        return { status: response.status, headers };
      },
      catch: () => new SentryTransportFailed(),
    }).pipe(Effect.timeout("5 seconds"), Effect.option);
    return HttpServerResponse.empty(Option.isSome(response) ? response.value : { status: 502 });
  });
});
