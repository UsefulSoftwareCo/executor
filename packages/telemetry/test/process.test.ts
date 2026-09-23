/** Exercise the native process adapter, its scope, and the real file/export seams. */
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { test } from "node:test";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  ConfigProvider,
  Effect,
  FileSystem,
  Layer,
  Logger,
  ManagedRuntime,
  Metric,
  Schema,
} from "effect";
import { TestClock } from "effect/testing";
import { startProcessMetrics } from "../src/process.ts";
import { localTelemetry } from "../src/local.ts";

const RuntimeLog = Schema.fromJsonString(
  Schema.Struct({
    message: Schema.Literal("process.runtime"),
    annotations: Schema.Struct({
      "service.name": Schema.String,
      "process.pid": Schema.Number,
      "sample.duration.seconds": Schema.Number,
      "process.cpu.cores": Schema.Number,
      "process.cpu.user.seconds": Schema.Number,
      "process.memory.rss.bytes": Schema.Number,
      "process.memory.heap.used.bytes": Schema.Number,
      "process.memory.heap.total.bytes": Schema.Number,
      "process.memory.external.bytes": Schema.Number,
      "eventloop.utilization": Schema.Number,
      "eventloop.delay.mean.ms": Schema.Number,
      "eventloop.delay.p99.ms": Schema.Number,
      "eventloop.delay.max.ms": Schema.Number,
    }),
  }),
);

test("native samples measure CPU, memory and blocked event loops without delaying startup; scope stops sampling", async () => {
  const lines: string[] = [];
  const logger = Logger.make((options) => {
    lines.push(Logger.formatJson.log(options));
  });
  await Effect.runPromise(
    Effect.gen(function* () {
      yield* Effect.scoped(
        Effect.gen(function* () {
          yield* startProcessMetrics("runtime-test");
          assert.equal(lines.length, 0, "startup must not await the first measurement");
          yield* TestClock.adjust("999 millis");
          assert.equal(lines.length, 0, "do not emit a zero-length initial interval");
          // Give the real native histogram time to start, block it, then let it observe the delay.
          yield* TestClock.withLive(Effect.sleep("50 millis"));
          yield* Effect.sync(() => {
            const until = performance.now() + 80;
            while (performance.now() < until) Math.sqrt(performance.now());
          });
          yield* TestClock.withLive(Effect.sleep("50 millis"));
          yield* TestClock.adjust("1 millis");
          assert.equal(lines.length, 1);
          const first = Schema.decodeUnknownSync(RuntimeLog)(lines[0]).annotations;
          assert.equal(first["service.name"], "runtime-test");
          assert.equal(first["process.pid"], process.pid);
          assert.ok(first["sample.duration.seconds"] > 0);
          assert.ok(first["process.cpu.cores"] > 0);
          assert.ok(first["process.memory.rss.bytes"] > 0);
          assert.ok(first["process.memory.heap.used.bytes"] > 0);
          assert.ok(
            first["process.memory.heap.total.bytes"] >= first["process.memory.heap.used.bytes"],
          );
          assert.ok(first["eventloop.utilization"] >= 0 && first["eventloop.utilization"] <= 1);
          assert.ok(
            first["eventloop.delay.max.ms"] >= 70,
            "native delay monitor must observe the blocked loop",
          );
          const snapshot = yield* Metric.snapshot;
          const rss = snapshot.find((metric) => metric.id === "process.memory.usage");
          assert.equal(rss?.type, "Gauge");
          assert.ok(rss !== undefined && rss.type === "Gauge");
          assert.equal(rss.state.value, first["process.memory.rss.bytes"]);
          assert.equal(rss.attributes?.unit, "By");
          yield* TestClock.adjust("29 seconds");
          assert.equal(lines.length, 1);
          yield* TestClock.withLive(Effect.sleep("50 millis"));
          yield* TestClock.adjust("1 second");
          assert.equal(lines.length, 2);
          const second = Schema.decodeUnknownSync(RuntimeLog)(lines[1]).annotations;
          assert.ok(second["process.cpu.user.seconds"] >= first["process.cpu.user.seconds"]);
          assert.ok(
            second["eventloop.delay.max.ms"] < first["eventloop.delay.max.ms"],
            "each delay window must reset",
          );
        }),
      );
      yield* TestClock.adjust("2 minutes");
      assert.equal(lines.length, 2, "a disposed host must not keep sampling");
    }).pipe(
      Effect.provide(TestClock.layer()),
      Effect.provide(Logger.layer([logger])),
      Effect.provideService(Metric.MetricRegistry, new Map()),
    ),
  );
});

test(
  "local hosts retain process logs and export the same registry when metrics are configured",
  { timeout: 10_000 },
  async () => {
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
      const origin = `http://127.0.0.1:${address.port}`;
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const fs = yield* FileSystem.FileSystem;
            const directory = yield* fs.makeTempDirectoryScoped();
            const runtime = ManagedRuntime.make(
              localTelemetry(directory, "runtime-export-test").pipe(
                Layer.provide(NodeServices.layer),
                Layer.provide(
                  Layer.succeed(
                    ConfigProvider.ConfigProvider,
                    ConfigProvider.fromUnknown({
                      OTEL_EXPORTER_OTLP_ENDPOINT: origin,
                    }),
                  ),
                ),
              ),
            );
            yield* Effect.addFinalizer(() => Effect.promise(() => runtime.dispose()));
            yield* Effect.promise(() => runtime.runPromise(Effect.sleep("1300 millis")));
            yield* Effect.promise(() => runtime.dispose());
            const logs = yield* fs.readFileString(
              `${directory}/diagnostics/runtime-export-test.jsonl`,
            );
            const entry = Schema.decodeUnknownSync(RuntimeLog)(logs.trim());
            assert.equal(entry.annotations["service.name"], "runtime-export-test");
            assert.ok(entry.annotations["sample.duration.seconds"] >= 1);
          }),
        ).pipe(Effect.provide(NodeServices.layer)),
      );
      const metrics = received
        .filter((entry) => entry.path === "/v1/metrics")
        .map((entry) => entry.body)
        .join("\n");
      assert.match(metrics, /process.memory.usage/);
      assert.match(metrics, /nodejs.eventloop.delay.p99/);
      const logs = received
        .filter((entry) => entry.path === "/v1/logs")
        .map((entry) => entry.body)
        .join("\n");
      assert.match(logs, /process.runtime/);
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  },
);
