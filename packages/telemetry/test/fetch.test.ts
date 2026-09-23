/** The app-facing Promise adapter uses Effect's HTTP tracing and cancellation. */
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { test } from "node:test";
import { Deferred, Effect, Schema } from "effect";
import { collectTelemetry, invocationFetch } from "../src/index.ts";

const Export = Schema.fromJsonString(
  Schema.Struct({
    resourceSpans: Schema.Array(
      Schema.Struct({
        scopeSpans: Schema.Array(
          Schema.Struct({
            spans: Schema.Array(
              Schema.Struct({
                name: Schema.String,
                spanId: Schema.String,
                traceId: Schema.String,
                parentSpanId: Schema.optional(Schema.String),
                startTimeUnixNano: Schema.String,
                endTimeUnixNano: Schema.String,
              }),
            ),
          }),
        ),
      }),
    ),
  }),
);

test("invocation fetch preserves request/response bodies and native trace propagation", async () => {
  let parent: string | undefined;
  const server = createServer(async (request, response) => {
    parent = String(request.headers.traceparent);
    let body = "";
    for await (const chunk of request) body += chunk;
    response
      .writeHead(201, { "content-type": "application/json", "x-result": "created" })
      .end(JSON.stringify({ body }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    assert.ok(address !== null && typeof address !== "string");
    const captured = await Effect.runPromise(
      collectTelemetry(
        Effect.gen(function* () {
          const request = yield* invocationFetch(new AbortController().signal);
          const response = yield* Effect.promise(() =>
            request(`http://127.0.0.1:${address.port}`, {
              method: "POST",
              headers: { authorization: "Bearer secret-sentinel" },
              body: "payload",
            }),
          );
          assert.equal(response.status, 201);
          assert.equal(response.headers.get("x-result"), "created");
          assert.deepEqual(yield* Effect.promise(() => response.json()), { body: "payload" });
          return (yield* Effect.currentSpan).traceId;
        }).pipe(Effect.withSpan("app.call")),
      ),
    );
    assert.ok(parent?.includes(captured.value));
    const spans = captured.telemetry.traces.flatMap((batch) =>
      Schema.decodeUnknownSync(Export)(batch).resourceSpans.flatMap((resource) =>
        resource.scopeSpans.flatMap((scope) => scope.spans),
      ),
    );
    const invocation = spans.find((span) => span.name === "app.call");
    const provider = spans.find((span) => span.name === "provider.http.request");
    const http = spans.find((span) => span.name === "http.client POST");
    const body = spans.find((span) => span.name === "provider.http.response.read");
    assert.ok(invocation && provider && http && body);
    assert.equal(provider.parentSpanId, invocation.spanId);
    assert.equal(http.parentSpanId, provider.spanId);
    assert.equal(body.parentSpanId, invocation.spanId);
    for (const span of [provider, http, body]) assert.equal(span.traceId, captured.value);
    assert.ok(parent?.includes(http.spanId), "The native HTTP span still propagates upstream");
    assert.ok(BigInt(provider.startTimeUnixNano) <= BigInt(http.startTimeUnixNano));
    assert.ok(BigInt(provider.endTimeUnixNano) >= BigInt(http.endTimeUnixNano));
    assert.ok(
      BigInt(body.startTimeUnixNano) >= BigInt(provider.endTimeUnixNano),
      "Response reading remains a separate phase after headers arrive",
    );
    assert.ok(BigInt(invocation.endTimeUnixNano) >= BigInt(body.endTimeUnixNano));
    const traces = captured.telemetry.traces.join("");
    assert.match(traces, /http.client POST/);
    assert.match(traces, /provider.http.response.read/);
    assert.doesNotMatch(traces, /http.request.header.authorization/);
    assert.doesNotMatch(traces, /secret-sentinel/);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("host cancellation stops an in-flight invocation fetch", async () => {
  const started = Deferred.makeUnsafe<void>();
  const server = createServer(() => {
    Deferred.doneUnsafe(started, Effect.void);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    assert.ok(address !== null && typeof address !== "string");
    const abort = new AbortController();
    const request = await Effect.runPromise(invocationFetch(abort.signal));
    const pending = request(`http://127.0.0.1:${address.port}`);
    const rejected = assert.rejects(pending);
    await Effect.runPromise(Deferred.await(started));
    abort.abort();
    await rejected;
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("response reading stays traced and abortable after the HTTP headers arrive", async () => {
  const server = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/plain", "set-cookie": "fixture=ok" });
    response.write("first chunk");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    assert.ok(address !== null && typeof address !== "string");
    const abort = new AbortController();
    const collected = await Effect.runPromise(
      collectTelemetry(
        Effect.gen(function* () {
          const request = yield* invocationFetch(abort.signal);
          const response = yield* Effect.promise(() => request(`http://127.0.0.1:${address.port}`));
          assert.equal(response.headers.get("set-cookie"), "fixture=ok");
          const reader = response.body?.getReader();
          assert.ok(reader);
          const first = yield* Effect.promise(() => reader.read());
          assert.equal(new TextDecoder().decode(first.value), "first chunk");
          const pending = reader.read();
          const rejected = assert.rejects(pending);
          abort.abort();
          yield* Effect.promise(() => rejected);
        }).pipe(Effect.withSpan("streaming.invocation")),
      ),
    );
    const traces = collected.telemetry.traces.join("");
    assert.match(traces, /provider.http.response.read/);
    assert.match(traces, /"code":2/);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
