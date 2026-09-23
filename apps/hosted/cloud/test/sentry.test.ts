import assert from "node:assert/strict";
import { createServer } from "node:http";
import { test } from "node:test";
import { Effect } from "effect";
import { HttpServerError, HttpServerRequest } from "effect/unstable/http";
import { withCloudSentry, reportCloudFailure } from "../src/implementation/error-reporting.ts";

test("concurrent Effect failures keep separate Sentry clients and flush once per exception", async () => {
  const received: string[] = [];
  const server = createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += String(chunk);
    received.push(body);
    response.writeHead(200, { "content-type": "application/json" }).end("{}");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const report = (environment: string) => {
      const error = new Error(`failure-${environment}`);
      error.stack = `Error: failure-${environment}\n    at synthetic (worker.js:12:4)`;
      return Effect.scoped(
        withCloudSentry(
          Effect.fail(error).pipe(Effect.tapCause(reportCloudFailure)),
          Effect.succeed({
            dsn: `http://public@127.0.0.1:${address.port}/1`,
            environment,
            release: "test-release",
          }),
        ).pipe(Effect.exit),
      );
    };
    await Effect.runPromise(Effect.all([report("first"), report("second")], { concurrency: 2 }));
    assert.equal(received.length, 2);
    const events = received.map((body) => JSON.parse(body.split("\n")[2] ?? "null"));
    assert.deepEqual(events.map((event) => event.environment).sort(), ["first", "second"]);
    for (const event of events) {
      assert.equal(event.release, "test-release");
      assert.equal(event.exception.values[0].value, `failure-${event.environment}`);
      assert.ok(event.exception.values[0].stacktrace.frames.length > 0);
      assert.equal(event.exception.values[0].stacktrace.frames[0].abs_path, "/worker.js");
    }
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});

test("an unmatched route is never forwarded to Sentry", async () => {
  const received: string[] = [];
  const server = createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += String(chunk);
    received.push(body);
    response.writeHead(200, { "content-type": "application/json" }).end("{}");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const request = HttpServerRequest.fromWeb(
      new Request("https://cloud.example/api/gateway/heartbeat", { method: "POST" }),
    );
    const routeNotFound = new HttpServerError.HttpServerError({
      reason: new HttpServerError.RouteNotFound({ request }),
    });
    await Effect.runPromise(
      Effect.scoped(
        withCloudSentry(
          Effect.fail(routeNotFound).pipe(Effect.tapCause(reportCloudFailure)),
          Effect.succeed({
            dsn: `http://public@127.0.0.1:${address.port}/1`,
            environment: "ignored-route",
            release: "test-release",
          }),
        ).pipe(Effect.exit),
      ),
    );
    assert.equal(received.length, 0);
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});
