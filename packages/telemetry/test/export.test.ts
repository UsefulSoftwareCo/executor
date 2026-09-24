/** Exercise real HTTP export, scope drain, signal selection and privacy at the collector seam. */
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { test } from "node:test";
import { ConfigProvider, Deferred, Effect, Logger, Metric, Redacted, Schema, Tracer } from "effect";
import { FetchHttpClient } from "effect/unstable/http";
import { telemetryConfig, TelemetryConfig, telemetryLayer } from "../src/index.ts";

test(
  "a stalled collector request is released and the same trace batch is delivered",
  { timeout: 15000 },
  async () => {
    const delivered = Deferred.makeUnsafe<void>();
    const bodies: string[] = [];
    let released = false;
    const server = createServer((request, response) => {
      let body = "";
      request.setEncoding("utf8");
      request.on("data", (chunk) => {
        body += chunk;
      });
      request.on("end", () => {
        bodies.push(body);
        if (bodies.length === 1) {
          response.on("close", () => {
            released = true;
          });
          return;
        }
        response.writeHead(200, { "content-type": "application/json" });
        response.end("{}");
        Deferred.doneUnsafe(delivered, Effect.void);
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const address = server.address();
      assert.ok(address !== null && typeof address !== "string");
      await Effect.runPromise(
        Effect.void.pipe(
          Effect.withSpan("delivered after stalled export"),
          Effect.andThen(Deferred.await(delivered)),
          Effect.timeout("9 seconds"),
          Effect.provide(
            telemetryLayer({
              service: "stalled-export",
              version: "test",
              environment: "test",
              traces: { url: `http://127.0.0.1:${address.port}/v1/traces` },
            }),
          ),
        ),
      );
      assert.equal(released, true);
      assert.equal(bodies.length, 2);
      assert.equal(bodies[0], bodies[1]);
      assert.match(bodies[1] ?? "", /delivered after stalled export/);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  },
);

const Attribute = Schema.Struct({
  key: Schema.String,
  value: Schema.Record(Schema.String, Schema.Unknown),
});
const Traces = Schema.fromJsonString(
  Schema.Struct({
    resourceSpans: Schema.Array(
      Schema.Struct({
        resource: Schema.Struct({ attributes: Schema.Array(Attribute) }),
        scopeSpans: Schema.Array(
          Schema.Struct({
            spans: Schema.Array(
              Schema.Struct({
                traceId: Schema.String,
                spanId: Schema.String,
                parentSpanId: Schema.optional(Schema.String),
                name: Schema.String,
                status: Schema.Struct({ code: Schema.Number }),
                attributes: Schema.Array(Attribute),
              }),
            ),
          }),
        ),
      }),
    ),
  }),
);
const Logs = Schema.fromJsonString(
  Schema.Struct({
    resourceLogs: Schema.Array(
      Schema.Struct({
        scopeLogs: Schema.Array(
          Schema.Struct({
            logRecords: Schema.Array(
              Schema.Struct({
                traceId: Schema.String,
                spanId: Schema.String,
                body: Schema.Struct({ stringValue: Schema.String }),
              }),
            ),
          }),
        ),
      }),
    ),
  }),
);
const Metrics = Schema.fromJsonString(
  Schema.Struct({
    resourceMetrics: Schema.Array(
      Schema.Struct({
        scopeMetrics: Schema.Array(
          Schema.Struct({
            metrics: Schema.Array(
              Schema.Struct({
                name: Schema.String,
                sum: Schema.optional(
                  Schema.Struct({
                    dataPoints: Schema.Array(Schema.Struct({ asDouble: Schema.Number })),
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

test("caller sampling cannot suppress a server failure", async () => {
  const bodies: string[] = [];
  const capture: typeof fetch = async (input, init) => {
    bodies.push(await new Request(input, init).text());
    return Response.json({});
  };
  const traceId = "1234567890abcdef1234567890abcdef";
  await Effect.runPromise(
    Effect.fail(new Error("Synthetic server failure")).pipe(
      Effect.withSpan("server.operation", {
        kind: "server",
        parent: Tracer.externalSpan({ traceId, spanId: "1234567890abcdef", sampled: false }),
      }),
      Effect.ignore,
      Effect.provide(
        telemetryLayer(
          {
            service: "test",
            version: "test",
            environment: "test",
            traces: { url: "http://collector.test/v1/traces" },
          },
          "event",
        ),
      ),
      Effect.provideService(FetchHttpClient.Fetch, capture),
    ),
  );
  const spans = bodies.flatMap((body) =>
    Schema.decodeUnknownSync(Traces)(body).resourceSpans.flatMap((resource) =>
      resource.scopeSpans.flatMap((scope) => scope.spans),
    ),
  );
  assert.equal(spans.length, 1);
  assert.equal(spans[0]?.traceId, traceId);
  assert.equal(spans[0]?.status.code, 2);
});

test("event exporters release HTTP responses before their scope finishes", async () => {
  const signals: AbortSignal[] = [];
  const capture: typeof fetch = async (_input, init) => {
    assert.ok(init?.signal);
    signals.push(init.signal);
    return Response.json({});
  };
  await Effect.runPromise(
    Effect.void.pipe(
      Effect.withSpan("owned export"),
      Effect.provide(
        telemetryLayer(
          {
            service: "scope-check",
            version: "test",
            environment: "test",
            traces: { url: "https://collector.test/v1/traces" },
          },
          "event",
        ),
      ),
      Effect.provideService(FetchHttpClient.Fetch, capture),
    ),
  );
  assert.ok(signals.length > 0);
  assert.ok(
    signals.every((signal) => signal.aborted),
    "response cleanup must not depend on garbage collection",
  );
});

test("native OTLP preserves diagnostics, correlation and wrapped Redacted values", async () => {
  const received: Array<{ path: string; body: string }> = [];
  const server = createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += chunk;
    received.push({ path: request.url ?? "", body });
    response.writeHead(200, { "content-type": "application/json" }).end("{}");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    assert.ok(address !== null && typeof address !== "string");
    const endpoint = `http://127.0.0.1:${address.port}`;
    const config = Schema.decodeUnknownSync(TelemetryConfig)({
      service: "telemetry-test",
      version: "test-build",
      environment: "test",
      metricsProtocol: "http/json",
      traces: { url: `${endpoint}/v1/traces` },
      logs: { url: `${endpoint}/v1/logs` },
      metrics: { url: `${endpoint}/v1/metrics` },
    });
    for (let index = 0; index < 2; index++) {
      await Effect.runPromise(
        Effect.gen(function* () {
          yield* Metric.update(Metric.counter("executor.test.calls"), 1);
          yield* Effect.gen(function* () {
            yield* Effect.annotateCurrentSpan({
              "feature.name": "tool-discovery",
              "retry.attempt": 2,
            });
            yield* Effect.logInfo("Connection established");
            yield* Effect.logInfo(Redacted.make("secret-sentinel"));
            yield* Effect.fail(new Error("Connection timed out")).pipe(
              Effect.withSpan("failure"),
              Effect.ignore,
            );
          }).pipe(Effect.withSpan("child"));
        }).pipe(Effect.withSpan("root"), Effect.provide(telemetryLayer(config, "event"))),
      );
    }
    const text = received.map((record) => record.body).join("\n");
    assert.doesNotMatch(text, /secret-sentinel/);
    assert.match(text, /Connection timed out/);
    assert.match(text, /exception.message/);
    assert.match(text, /exception.stacktrace/);
    const traces = received
      .filter((record) => record.path === "/v1/traces")
      .flatMap((record) => Schema.decodeUnknownSync(Traces)(record.body).resourceSpans);
    const spans = traces.flatMap((resource) => resource.scopeSpans.flatMap((scope) => scope.spans));
    assert.equal(spans.filter((span) => span.name === "root").length, 2);
    for (const child of spans.filter((span) => span.name === "child")) {
      assert.ok(
        child.attributes.some(
          (item) => item.key === "feature.name" && item.value.stringValue === "tool-discovery",
        ),
      );
      const root = spans.find((span) => span.spanId === child.parentSpanId);
      assert.equal(root?.name, "root");
      assert.equal(root?.traceId, child.traceId);
    }
    assert.ok(
      spans.filter((span) => span.name === "failure").every((span) => span.status.code === 2),
    );
    assert.ok(
      traces.every((resource) =>
        resource.resource.attributes.some(
          (item) => item.key === "service.version" && item.value.stringValue === "test-build",
        ),
      ),
    );
    const logs = received
      .filter((record) => record.path === "/v1/logs")
      .flatMap((record) =>
        Schema.decodeUnknownSync(Logs)(record.body).resourceLogs.flatMap((resource) =>
          resource.scopeLogs.flatMap((scope) => scope.logRecords),
        ),
      );
    assert.equal(logs.filter((log) => log.body.stringValue === "Connection established").length, 2);
    assert.ok(
      logs.every((log) =>
        spans.some((span) => span.spanId === log.spanId && span.traceId === log.traceId),
      ),
    );
    const metrics = received
      .filter((record) => record.path === "/v1/metrics")
      .flatMap((record) =>
        Schema.decodeUnknownSync(Metrics)(record.body).resourceMetrics.flatMap((resource) =>
          resource.scopeMetrics.flatMap((scope) => scope.metrics),
        ),
      );
    const counters = metrics.filter((metric) => metric.name === "executor.test.calls");
    assert.equal(counters.length, 2);
    assert.deepEqual(
      counters.map((counter) => counter.sum?.dataPoints.map((point) => point.asDouble)),
      [[1], [1]],
    );
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});

test("OTLP base config supplies all three signal endpoints", async () => {
  const config = await Effect.runPromise(
    telemetryConfig("executor-local").pipe(
      Effect.provideService(
        ConfigProvider.ConfigProvider,
        ConfigProvider.fromUnknown({ OTEL_EXPORTER_OTLP_ENDPOINT: "http://127.0.0.1:27686" }),
      ),
    ),
  );
  assert.equal(config.traces?.url, "http://127.0.0.1:27686/v1/traces");
  assert.equal(config.logs?.url, "http://127.0.0.1:27686/v1/logs");
  assert.equal(config.metrics?.url, "http://127.0.0.1:27686/v1/metrics");
});

test("Motel is configured with explicit traces and logs endpoints", async () => {
  const config = await Effect.runPromise(
    telemetryConfig("executor-local").pipe(
      Effect.provideService(
        ConfigProvider.ConfigProvider,
        ConfigProvider.fromUnknown({
          OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: "http://127.0.0.1:27686/v1/traces",
          OTEL_EXPORTER_OTLP_LOGS_ENDPOINT: "http://127.0.0.1:27686/v1/logs",
        }),
      ),
    ),
  );
  assert.equal(config.traces?.url, "http://127.0.0.1:27686/v1/traces");
  assert.equal(config.logs?.url, "http://127.0.0.1:27686/v1/logs");
  assert.equal(config.metrics, undefined);
});

test("a signal endpoint overrides the base without rewriting its path", async () => {
  const config = await Effect.runPromise(
    telemetryConfig("executor-local").pipe(
      Effect.provideService(
        ConfigProvider.ConfigProvider,
        ConfigProvider.fromUnknown({
          OTEL_EXPORTER_OTLP_ENDPOINT: "http://collector.test/otel?source=development",
          OTEL_EXPORTER_OTLP_METRICS_ENDPOINT: "http://metrics.test/ingest",
        }),
      ),
    ),
  );
  assert.equal(config.traces?.url, "http://collector.test/otel/v1/traces?source=development");
  assert.equal(config.metrics?.url, "http://metrics.test/ingest");
});

for (const fixture of [
  {
    name: "traces",
    type: "application/json",
    body: '{"partialSuccess":{"rejectedSpans":"3","errorMessage":"private-collector-message"}}',
    rejected: 3,
  },
  {
    name: "logs",
    type: "application/json",
    body: '{"partialSuccess":{"rejectedLogRecords":2}}',
    rejected: 2,
  },
  {
    name: "metrics",
    type: "application/x-protobuf",
    body: new Uint8Array([10, 2, 8, 4]),
    rejected: 4,
  },
]) {
  test(`partial ${fixture.name} acceptance records loss without resending accepted records`, async () => {
    const lines: string[] = [];
    let requests = 0;
    const server = createServer(async (request, response) => {
      for await (const _chunk of request) {
        /* consume the real export */
      }
      requests++;
      response.writeHead(200, { "content-type": fixture.type }).end(fixture.body);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const address = server.address();
      assert.ok(address !== null && typeof address !== "string");
      await Effect.runPromise(
        Effect.void.pipe(
          Effect.withSpan("partial-acceptance"),
          Effect.provide(
            telemetryLayer(
              {
                service: "test",
                version: "test",
                environment: "test",
                traces: { url: `http://127.0.0.1:${address.port}/v1/${fixture.name}` },
              },
              "event",
              Logger.make((options) => {
                lines.push(Logger.formatJson.log(options));
              }),
            ),
          ),
        ),
      );
      assert.equal(requests, 1, "Partial success must never retry accepted records");
      const log = lines.join("\n");
      assert.match(log, /partial-success/);
      assert.ok(log.includes(`"executor.telemetry.rejected_records":${fixture.rejected}`));
      assert.doesNotMatch(log, /private-collector-message/);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
}

test("shutdown interruption remains visible in the host logger", { timeout: 6000 }, async () => {
  const lines: string[] = [];
  const server = createServer(async (request) => {
    for await (const _chunk of request) {
      /* deliberately never acknowledge */
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    assert.ok(address !== null && typeof address !== "string");
    await Effect.runPromise(
      Effect.void.pipe(
        Effect.withSpan("shutdown"),
        Effect.provide(
          telemetryLayer(
            {
              service: "test",
              version: "test",
              environment: "test",
              traces: { url: `http://127.0.0.1:${address.port}/v1/traces` },
            },
            "event",
            Logger.make((options) => {
              lines.push(Logger.formatJson.log(options));
            }),
          ),
        ),
      ),
    );
    assert.match(lines.join("\n"), /interrupted/);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
