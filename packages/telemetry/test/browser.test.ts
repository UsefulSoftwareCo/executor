/** Page events and API calls share one native exporter through separate Atom registries. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { createServer } from "node:http";
import { Effect, Schema } from "effect";
import { AtomRegistry, AsyncResult } from "effect/unstable/reactivity";
import { HttpClient, FetchHttpClient } from "effect/unstable/http";
import { HttpApi, HttpApiClient, HttpApiEndpoint, HttpApiGroup } from "effect/unstable/httpapi";
import { BrowserTelemetry, makeBrowserTelemetry } from "../src/browser.ts";

test("page runtime exports errors and API parents and removes listeners on disposal", async () => {
  const events = new EventTarget();
  const page = new EventTarget();
  Object.defineProperty(globalThis, "window", { configurable: true, value: events });
  Object.defineProperty(globalThis, "document", { configurable: true, value: page });
  const bodies: string[] = [];
  let traceparent: string | undefined;
  const server = createServer(async (request, response) => {
    if (request.url === "/operation") traceparent = String(request.headers.traceparent);
    else {
      let body = "";
      for await (const chunk of request) body += chunk;
      bodies.push(body);
    }
    response.writeHead(200, { "content-type": "application/json" }).end("{}");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address !== null && typeof address !== "string");
  const origin = `http://127.0.0.1:${address.port}`;
  const { runtime, atoms } = makeBrowserTelemetry(
    Effect.succeed({
      service: "browser-test",
      version: "build-test",
      environment: "test",
      traces: { url: `${origin}/traces` },
      logs: { url: `${origin}/logs` },
    }),
  );
  const registry = AtomRegistry.make();
  try {
    const telemetry = await runtime.runPromise(BrowserTelemetry);
    await runtime.runPromise(telemetry.navigation({ type: "start", path: "/apps" }));
    const contract = HttpApi.make("check").add(
      HttpApiGroup.make("check").add(
        HttpApiEndpoint.get("operation", "/operation", { success: Schema.Struct({}) }),
      ),
    );
    await runtime.runPromise(telemetry.navigation({ type: "end" }));
    const api = atoms(FetchHttpClient.layer).atom(
      Effect.gen(function* () {
        const client = yield* HttpApiClient.make(contract, {
          baseUrl: origin,
          transformClient: (client) =>
            client.pipe(HttpClient.transformResponse(Effect.withSpan("ui.action"))),
        });
        return yield* client.check.operation();
      }),
    );
    await new Promise<void>((resolve, reject) =>
      registry.subscribe(
        api,
        (result) => {
          if (AsyncResult.isSuccess(result)) resolve();
          else if (AsyncResult.isFailure(result)) reject(result.cause);
        },
        { immediate: true },
      ),
    );
    const error = new Event("error");
    Object.defineProperties(error, {
      error: { value: new Error("browser diagnostic") },
      message: { value: "browser diagnostic" },
    });
    events.dispatchEvent(error);
    // Complete the listener's owned fiber before flushing.
    await runtime.runPromise(Effect.yieldNow);
    await runtime.runPromise(telemetry.flush);
    const all = bodies.join("\n");
    assert.match(all, /ui.navigation/);
    assert.match(all, /ui.action/);
    assert.match(all, /ui.error/);
    assert.match(all, /browser diagnostic/);
    assert.match(
      bodies.filter((body) => body.includes('"resourceLogs"')).join("\n"),
      /browser diagnostic/,
    );
    assert.ok(traceparent !== undefined && traceparent.startsWith("00-"));
    const propagated = traceparent.split("-");
    const traceId = propagated[1];
    assert.ok(traceId && all.includes(traceId));
    const payload = Schema.fromJsonString(
      Schema.Struct({
        resourceSpans: Schema.Array(
          Schema.Struct({
            scopeSpans: Schema.Array(
              Schema.Struct({
                spans: Schema.Array(
                  Schema.Struct({
                    traceId: Schema.String,
                    spanId: Schema.String,
                    parentSpanId: Schema.optional(Schema.String),
                    name: Schema.String,
                  }),
                ),
              }),
            ),
          }),
        ),
      }),
    );
    const spans = bodies
      .filter((body) => body.includes('"resourceSpans"'))
      .flatMap((body) =>
        Schema.decodeUnknownSync(payload)(body).resourceSpans.flatMap((r) =>
          r.scopeSpans.flatMap((s) => s.spans),
        ),
      );
    const outgoing = spans.find((span) => span.spanId === propagated[2]);
    const action = spans.find((span) => span.spanId === outgoing?.parentSpanId);
    assert.equal(action?.name, "ui.action");
    assert.ok(action);
    assert.equal(action.traceId, traceId);
    assert.ok(!action.parentSpanId, "a concurrent navigation does not become the API parent");
    assert.notEqual(spans.find((span) => span.name === "ui.navigation")?.traceId, action.traceId);
    registry.dispose();
    await runtime.dispose();
    const count = bodies.length;
    events.dispatchEvent(error);
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(bodies.length, count);
  } finally {
    registry.dispose();
    await runtime.dispose();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    Reflect.deleteProperty(globalThis, "window");
    Reflect.deleteProperty(globalThis, "document");
  }
});
