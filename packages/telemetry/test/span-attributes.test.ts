/** HTTP spans carry an allowlist. Credential headers and query strings never reach one. */
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { test } from "node:test";
import { Effect, Schema } from "effect";
import { collectTelemetry, invocationFetch } from "../src/index.ts";
import { spanAttributeAllowed } from "../src/span-attributes.ts";

const Export = Schema.fromJsonString(
  Schema.Struct({
    resourceSpans: Schema.Array(
      Schema.Struct({
        scopeSpans: Schema.Array(
          Schema.Struct({
            spans: Schema.Array(
              Schema.Struct({
                name: Schema.String,
                attributes: Schema.Array(
                  Schema.Struct({
                    key: Schema.String,
                    value: Schema.Record(Schema.String, Schema.Json),
                  }),
                ),
              }),
            ),
          }),
        ),
      }),
    ),
  }),
);

test("only allowlisted HTTP attributes may be recorded", () => {
  for (const key of [
    "http.request.method",
    "url.path",
    "url.scheme",
    "server.address",
    "http.response.status_code",
    "http.request.header.content-type",
    "http.request.header.user-agent",
  ])
    assert.equal(spanAttributeAllowed(key), true, key);
  for (const key of [
    "url.full",
    "url.query",
    "http.request.header.authorization",
    // A name no denylist would have held: the unsubscribe token rides this one.
    "http.response.header.location",
    // Any provider name at all, whether or not it looks like a credential.
    "http.request.header.x-acme-session",
    "client.address",
  ])
    assert.equal(spanAttributeAllowed(key), false, key);
});

test("product attributes outside the HTTP namespaces are untouched", () => {
  assert.equal(spanAttributeAllowed("executor.tool.name"), true);
  assert.equal(spanAttributeAllowed("browser.observation.duration_ms"), true);
});

test("a credential header and a token query parameter reach no span", async () => {
  const server = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "application/json" }).end("{}");
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
            // The unsubscribe link and every OpenAPI key-in-query provider look like this.
            request(`http://127.0.0.1:${address.port}/items?token=secret-sentinel&page=2`, {
              headers: { "x-acme-api-key": "secret-sentinel" },
            }),
          );
          assert.equal(response.status, 200);
        }).pipe(Effect.withSpan("app.call")),
      ),
    );
    const traces = captured.telemetry.traces.join("");
    assert.match(traces, /http.client GET/, "The client span is still exported");
    assert.doesNotMatch(traces, /secret-sentinel/);
    const spans = captured.telemetry.traces.flatMap((batch) =>
      Schema.decodeUnknownSync(Export)(batch).resourceSpans.flatMap((resource) =>
        resource.scopeSpans.flatMap((scope) => scope.spans),
      ),
    );
    const client = spans.find((span) => span.name === "http.client GET");
    assert.ok(client);
    const keys = client.attributes.map((attribute) => attribute.key);
    for (const key of keys) assert.equal(spanAttributeAllowed(key), true, key);
    assert.ok(keys.includes("url.path"), "The path is still recorded");
    assert.ok(!keys.includes("url.full"));
    assert.ok(!keys.includes("url.query"));
    assert.equal(
      client.attributes.find((attribute) => attribute.key === "url.path")?.value["stringValue"],
      "/items",
    );
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
