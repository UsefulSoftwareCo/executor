// ---------------------------------------------------------------------------
// Sentry tunnel — the browser SDK POSTs envelopes to /api/sentry-tunnel
// (configured in routes/__root.tsx) to dodge adblockers and CSP. We parse the
// envelope header to recover the DSN, validate against our own, and forward the
// body to Sentry's ingest endpoint. See
// https://docs.sentry.io/platforms/javascript/troubleshooting/#using-the-tunnel-option
// ---------------------------------------------------------------------------

import { env } from "cloudflare:workers";
import { createMiddleware } from "@tanstack/react-start";
import { Data, Effect, Schema } from "effect";

class SentryTunnelError extends Data.TaggedError("SentryTunnelError")<{
  readonly cause?: unknown;
}> {}

const SentryEnvelopeHeader = Schema.Struct({
  dsn: Schema.optional(Schema.String),
});

const decodeSentryEnvelopeHeader = Schema.decodeUnknownEffect(
  Schema.fromJsonString(SentryEnvelopeHeader),
);

const badSentryEnvelopeResponse = () => new Response("bad envelope", { status: 400 });

export const handleSentryTunnelRequest = (request: Request, configuredDsn: string) =>
  Effect.gen(function* () {
    const envelope = yield* Effect.tryPromise({
      try: () => request.text(),
      catch: (cause) => new SentryTunnelError({ cause }),
    });
    const firstLine = envelope.slice(0, envelope.indexOf("\n"));
    const header = yield* decodeSentryEnvelopeHeader(firstLine).pipe(
      Effect.mapError((cause) => new SentryTunnelError({ cause })),
    );
    const dsn = header.dsn;
    if (!dsn) return new Response("missing dsn", { status: 400 });

    const envelopeDsn = yield* Effect.try({
      try: () => new URL(dsn),
      catch: (cause) => new SentryTunnelError({ cause }),
    });
    const ourDsn = yield* Effect.try({
      try: () => new URL(configuredDsn),
      catch: (cause) => new SentryTunnelError({ cause }),
    });
    if (envelopeDsn.host !== ourDsn.host || envelopeDsn.pathname !== ourDsn.pathname) {
      return new Response("dsn mismatch", { status: 400 });
    }

    const projectId = envelopeDsn.pathname.replace(/^\//, "");
    const ingestUrl = `https://${envelopeDsn.host}/api/${projectId}/envelope/`;
    return yield* Effect.tryPromise({
      try: () =>
        fetch(ingestUrl, {
          method: "POST",
          body: envelope,
          headers: { "Content-Type": "application/x-sentry-envelope" },
        }),
      catch: (cause) => new SentryTunnelError({ cause }),
    });
  }).pipe(Effect.catch(() => Effect.succeed(badSentryEnvelopeResponse())));

export const sentryTunnelMiddleware = createMiddleware({ type: "request" }).server(
  ({ pathname, request, next }) => {
    if (pathname !== "/api/sentry-tunnel" || request.method !== "POST") {
      return next();
    }

    const configuredDsn = (env as { SENTRY_DSN?: string }).SENTRY_DSN;
    if (!configuredDsn) return new Response(null, { status: 204 });

    return Effect.runPromise(handleSentryTunnelRequest(request, configuredDsn));
  },
);
