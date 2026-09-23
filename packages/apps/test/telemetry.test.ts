/** Promise and isolate boundaries preserve a browser's parent without exposing exporter capabilities. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { Effect, Schema } from "effect";
import { collectTelemetry, TelemetryBatch } from "@executor-js/telemetry";
import { mutation, defineApp, object } from "../src/index.ts";
import { createIsolatedAppHandler, hostContext } from "../src/host.ts";

test("isolated app returns correlated records without receiving an OTLP secret", async () => {
  const app = defineApp({ accounts: {} }, async (_appContext) => ({
    mutations: {
      ping: mutation(
        { description: "Ping", input: object({}) },
        async (_operationContext, _input) => {
          return "pong";
        },
      ),
    },
  }));
  const response = await createIsolatedAppHandler(app)(
    new Request("https://app.internal/dispatch", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        traceparent: "00-11111111111111111111111111111111-2222222222222222-01",
      },
      body: JSON.stringify({ operation: "call", tool: "mutations.ping", input: {} }),
    }),
    hostContext({}),
  );
  const body = Schema.decodeUnknownSync(
    Schema.Struct({ ok: Schema.Boolean, value: Schema.String, telemetry: TelemetryBatch }),
  )(await response.json());
  assert.equal(body.ok, true);
  assert.equal(body.value, "pong");
  assert.equal(body.telemetry.dropped, 0);
  assert.ok(body.telemetry.traces.length > 0);
  assert.match(body.telemetry.traces.join(""), /11111111111111111111111111111111/);
  assert.match(body.telemetry.traces.join(""), /2222222222222222/);
});

test("collection flushes before returning, including native error details", async () => {
  const result = await Effect.runPromise(
    collectTelemetry(
      Effect.fail(new Error("Connection timed out")).pipe(
        Effect.withSpan("failure"),
        Effect.result,
      ),
    ),
  );
  assert.equal(result.telemetry.traces.length, 1);
  assert.match(result.telemetry.traces.join(""), /Connection timed out/);
});
