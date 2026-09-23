import assert from "node:assert/strict";
import { test } from "node:test";
import { Effect, Layer } from "effect";
import { HttpRouter, HttpServerResponse } from "effect/unstable/http";
import { sentryEnvelopeTarget } from "../src/implementation/error-tunnel.ts";

const dsn = "https://public-key@o1.ingest.sentry.io/123";
const envelope = (target: string) => `${JSON.stringify({ dsn: target })}\n{"type":"event"}\n{}\n`;

test("Sentry envelopes can only target the configured project", () => {
  assert.equal(
    sentryEnvelopeTarget(envelope(dsn), dsn),
    "https://o1.ingest.sentry.io/api/123/envelope/?sentry_version=7&sentry_key=public-key",
  );
  assert.equal(
    sentryEnvelopeTarget(envelope("https://public-key@attacker.example/123"), dsn),
    undefined,
  );
  assert.equal(
    sentryEnvelopeTarget(envelope("https://public-key@o1.ingest.sentry.io/456"), dsn),
    undefined,
  );
  assert.equal(sentryEnvelopeTarget("invalid\n{}", dsn), undefined);
  assert.equal(sentryEnvelopeTarget("{}", dsn), undefined);
});

test("telemetry routes preserve the existing auth route precedence", async () => {
  const web = HttpRouter.toWebHandler(
    Layer.mergeAll(
      HttpRouter.add(
        "POST",
        "/api/:channel/submit",
        Effect.succeed(HttpServerResponse.empty({ status: 201 })),
      ),
      HttpRouter.add(
        "*",
        "/api/:channel/*",
        Effect.succeed(HttpServerResponse.empty({ status: 202 })),
      ),
      HttpRouter.add(
        "POST",
        "/api/auth/sign-in",
        Effect.succeed(HttpServerResponse.empty({ status: 401 })),
      ),
    ),
    { disableLogger: true },
  );
  try {
    assert.equal(
      (await web.handler(new Request("https://example.test/api/errors/submit", { method: "POST" })))
        .status,
      201,
    );
    assert.equal(
      (await web.handler(new Request("https://example.test/api/events/e/", { method: "POST" })))
        .status,
      202,
    );
    assert.equal(
      (await web.handler(new Request("https://example.test/api/auth/sign-in", { method: "POST" })))
        .status,
      401,
    );
  } finally {
    await web.dispose();
  }
});
