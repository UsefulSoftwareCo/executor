/** Native diagnostic content survives the isolate-to-host OTLP relay. */
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { test } from "node:test";
import { Effect, Result, Schema, Tracer } from "effect";
import { HttpClientError } from "effect/unstable/http";
import { collectTelemetry, forwardTelemetry, telemetryLayer } from "../src/index.ts";

test("relay retains error messages, structured logs and custom attributes", async () => {
  const captured = await Effect.runPromise(
    collectTelemetry(
      Effect.gen(function* () {
        yield* Effect.annotateCurrentSpan("custom.details", { steps: ["connect", "retry"] });
        yield* Effect.logInfo({ message: "Connection retried", attempts: [1, 2] });
        yield* Effect.fail(new Error("Connection timed out")).pipe(
          Effect.withSpan("provider.call"),
          Effect.result,
        );
        return (yield* Effect.currentSpan).traceId;
      }).pipe(
        Effect.withSpan("app.call", {
          links: [
            {
              span: Tracer.externalSpan({
                traceId: "1234567890abcdef1234567890abcdef",
                spanId: "abcdef1234567890",
              }),
              attributes: { "executor.link.kind": "fixture" },
            },
          ],
        }),
      ),
    ),
  );
  const received: string[] = [];
  const receiver = createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += chunk;
    received.push(body);
    response.writeHead(200, { "content-type": "application/json" }).end("{}");
  });
  await new Promise<void>((resolve) => receiver.listen(0, "127.0.0.1", resolve));
  try {
    const address = receiver.address();
    assert.ok(address !== null && typeof address !== "string");
    const url = `http://127.0.0.1:${address.port}`;
    await Effect.runPromise(
      forwardTelemetry(captured.telemetry, captured.value, "test-build").pipe(
        Effect.provide(
          telemetryLayer(
            {
              service: "relay-test",
              version: "test",
              environment: "test",
              traces: { url: `${url}/v1/traces` },
              logs: { url: `${url}/v1/logs` },
            },
            "event",
          ),
        ),
      ),
    );
    const payload = received.join("\n");
    assert.match(payload, /Connection timed out/);
    assert.match(payload, /exception.stacktrace/);
    assert.match(payload, /custom.details/);
    assert.match(payload, /Connection retried/);
    assert.match(payload, /attempts/);
    assert.match(payload, /\[1,2\]/);
    assert.ok(payload.includes(captured.value));
    assert.match(payload, /"links":\[/);
    assert.match(payload, /"traceId":"1234567890abcdef1234567890abcdef"/);
    assert.match(payload, /"spanId":"abcdef1234567890"/);
  } finally {
    await new Promise<void>((resolve) => receiver.close(() => resolve()));
  }
});

test("relay failures retain collector status and decoding errors", async () => {
  const receiver = createServer((_request, response) => response.writeHead(503).end());
  await new Promise<void>((resolve) => receiver.listen(0, "127.0.0.1", resolve));
  try {
    const address = receiver.address();
    assert.ok(address !== null && typeof address !== "string");
    const layer = telemetryLayer(
      {
        service: "relay-test",
        version: "test",
        environment: "test",
        traces: { url: `http://127.0.0.1:${address.port}/v1/traces` },
      },
      "event",
    );
    const upstream = await Effect.runPromise(
      forwardTelemetry(
        { traces: ['{"resourceSpans":[]}'], logs: [], dropped: 0 },
        undefined,
        undefined,
      ).pipe(Effect.result, Effect.provide(layer)),
    );
    assert.ok(Result.isFailure(upstream) && HttpClientError.isHttpClientError(upstream.failure));
    assert.equal(upstream.failure.response?.status, 503);
    const invalid = await Effect.runPromise(
      forwardTelemetry({ traces: ["not json"], logs: [], dropped: 0 }, undefined, undefined).pipe(
        Effect.result,
        Effect.provide(layer),
      ),
    );
    assert.ok(Result.isFailure(invalid) && Schema.isSchemaError(invalid.failure));
  } finally {
    await new Promise<void>((resolve) => receiver.close(() => resolve()));
  }
});
