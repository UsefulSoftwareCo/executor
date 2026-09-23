/** Real bundled collector, disk retention, restart and shutdown checks. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { spawn } from "node:child_process";
import { once } from "node:events";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  ConfigProvider,
  Effect,
  FileSystem,
  Layer,
  Logger,
  ManagedRuntime,
  Path,
  Schema,
} from "effect";
import { OtlpExporter } from "effect/unstable/observability";
import { CurrentTelemetryConfig } from "../src/config.ts";
import { localTelemetry } from "../src/local.ts";
import { rotatingJsonLogger } from "../src/files.ts";
import { forwardTelemetry } from "../src/relay.ts";

const Collector = Schema.fromJsonString(
  Schema.Struct({
    state: Schema.String,
    url: Schema.optional(Schema.String),
    pid: Schema.optional(Schema.Number),
  }),
);

test("local telemetry opt-out does not start a collector or write diagnostics", async () => {
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const directory = yield* fs.makeTempDirectoryScoped();
        const runtime = ManagedRuntime.make(
          localTelemetry(directory, "disabled-test").pipe(
            Layer.provide(NodeServices.layer),
            Layer.provide(
              Layer.succeed(
                ConfigProvider.ConfigProvider,
                ConfigProvider.fromUnknown({ EXECUTOR_DISABLE_LOCAL_TELEMETRY: true }),
              ),
            ),
          ),
        );
        yield* Effect.addFinalizer(() => Effect.promise(() => runtime.dispose()));
        yield* Effect.promise(() => runtime.runPromise(Effect.logInfo("not persisted")));
        assert.equal(yield* fs.exists(`${directory}/diagnostics`), false);
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  );
});

test(
  "bundled collector searches and paginates the full seven-day retention window",
  { timeout: 20_000 },
  async () => {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const directory = yield* fs.makeTempDirectoryScoped();
          const runtime = ManagedRuntime.make(
            localTelemetry(directory, "retention-test").pipe(Layer.provide(NodeServices.layer)),
          );
          yield* Effect.addFinalizer(() => Effect.promise(() => runtime.dispose()));
          yield* Effect.promise(() => runtime.runPromise(Effect.logInfo("retention test ready")));
          yield* Effect.promise(() =>
            runtime.runPromise(Effect.flatMap(OtlpExporter.Flusher, (flusher) => flusher.flush)),
          );
          const state = yield* fs
            .readFileString(`${directory}/diagnostics/collector.json`)
            .pipe(Effect.flatMap(Schema.decodeUnknownEffect(Collector)));
          assert.ok(state.url);
          const url = state.url;
          const old = BigInt(Date.now() - 3 * 24 * 60 * 60 * 1000) * 1_000_000n;
          const resource = {
            attributes: [{ key: "service.name", value: { stringValue: "retained-fixture" } }],
          };
          const spans = [1, 2, 3].map((id) => ({
            traceId: id.toString(16).padStart(32, "0"),
            spanId: id.toString(16).padStart(16, "0"),
            name: `retained.${id}`,
            startTimeUnixNano: String(old + BigInt(id) * 1_000_000n),
            endTimeUnixNano: String(old + BigInt(id + 1) * 1_000_000n),
          }));
          for (const [signal, payload] of [
            ["traces", { resourceSpans: [{ resource, scopeSpans: [{ spans }] }] }],
            [
              "logs",
              {
                resourceLogs: [
                  {
                    resource,
                    scopeLogs: [
                      {
                        logRecords: spans.map((span) => ({
                          timeUnixNano: span.startTimeUnixNano,
                          observedTimeUnixNano: span.startTimeUnixNano,
                          body: { stringValue: span.name },
                          severityNumber: 9,
                        })),
                      },
                    ],
                  },
                ],
              },
            ],
          ] as const) {
            const response = yield* Effect.promise(() =>
              fetch(`${url}/v1/${signal}`, {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify(payload),
              }),
            );
            assert.equal(response.status, 200);
            const Page = Schema.Struct({
              data: Schema.Array(Schema.Unknown),
              meta: Schema.Struct({
                lookback: Schema.String,
                nextCursor: Schema.NullOr(Schema.String),
                truncated: Schema.Boolean,
              }),
            });
            let cursor: string | null = null;
            const records: unknown[] = [];
            for (let page = 0; page < 3; page++) {
              const endpoint: string = `${url}/api/${signal}?lookback=7d&service=retained-fixture&limit=1${cursor === null ? "" : `&cursor=${encodeURIComponent(cursor)}`}`;
              const result: typeof Page.Type = yield* Effect.promise(() =>
                fetch(endpoint).then((response) => response.json()),
              ).pipe(Effect.flatMap(Schema.decodeUnknownEffect(Page)));
              assert.equal(result.meta.lookback, "7d");
              assert.equal(result.data.length, 1);
              records.push(...result.data);
              cursor = result.meta.nextCursor;
              if (page < 2) assert.ok(cursor);
              else assert.equal(result.meta.truncated, false);
            }
            assert.equal(new Set(records.map((record) => JSON.stringify(record))).size, 3);
          }
        }),
      ).pipe(Effect.provide(NodeServices.layer)),
    );
  },
);

test(
  "Motel retains traces through a crash and local files survive collector downtime",
  { timeout: 35_000 },
  async () => {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const directory = yield* fs.makeTempDirectoryScoped({
            prefix: "executor-diagnostics-test-",
          });
          const runtime = ManagedRuntime.make(
            localTelemetry(directory, "executor-test").pipe(Layer.provide(NodeServices.layer)),
          );
          yield* Effect.addFinalizer(() => Effect.promise(() => runtime.dispose()));
          const config = yield* Effect.promise(() => runtime.runPromise(CurrentTelemetryConfig));
          assert.ok(config?.traces);
          const state = fs
            .readFileString(`${directory}/diagnostics/collector.json`)
            .pipe(Effect.flatMap(Schema.decodeUnknownEffect(Collector)));
          const before = yield* Effect.gen(function* () {
            while (true) {
              const current = yield* state;
              if (current.state === "running") return current;
              yield* Effect.sleep("25 millis");
            }
          }).pipe(Effect.timeout("10 seconds"));
          const url = before.url;
          assert.ok(url);
          assert.equal(before.state, "running");
          assert.ok(before.pid);
          yield* Effect.promise(() =>
            runtime.runPromise(
              Effect.logInfo("before collector crash").pipe(
                Effect.withSpan("diagnostics.persistence"),
              ),
            ),
          );
          yield* Effect.promise(() =>
            runtime.runPromise(Effect.flatMap(OtlpExporter.Flusher, (flusher) => flusher.flush)),
          );
          const traces = yield* Effect.promise(() =>
            fetch(`${url}/api/traces`).then((r) => r.text()),
          );
          assert.match(traces, /diagnostics.persistence/);
          process.kill(before.pid, "SIGKILL");
          yield* Effect.promise(() =>
            runtime.runPromise(Effect.logWarning("collector downtime diagnostic")),
          );
          const restarted = yield* Effect.gen(function* () {
            while (true) {
              const current = yield* state;
              if (current.state === "running" && current.pid !== before.pid) return current;
              yield* Effect.sleep("100 millis");
            }
          }).pipe(Effect.timeout("12 seconds"));
          assert.equal(restarted.url, url);
          const restartedPid = restarted.pid;
          assert.ok(restartedPid);
          const retained = yield* Effect.promise(() =>
            fetch(`${url}/api/traces`).then((r) => r.text()),
          );
          assert.match(retained, /diagnostics.persistence/);
          yield* Effect.promise(() => runtime.dispose());
          const logs = yield* fs.readFileString(`${directory}/diagnostics/executor-test.jsonl`);
          assert.match(logs, /before collector crash/);
          assert.match(logs, /collector downtime diagnostic/);
          assert.match(logs, /SIGKILL/);
          assert.equal((yield* state).state, "stopped");
          assert.throws(() => process.kill(restartedPid, 0), { code: "ESRCH" });
        }),
      ).pipe(Effect.provide(NodeServices.layer)),
    );
  },
);

test("JSONL rotation keeps five files and flushes the last log on close", async () => {
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const directory = yield* fs.makeTempDirectoryScoped();
        for (let index = 0; index < 7; index++) {
          yield* Effect.logInfo(`record ${index}`).pipe(
            Effect.provide(Logger.layer([rotatingJsonLogger(directory, "rotation", 1)])),
          );
        }
        const names = yield* fs.readDirectory(directory);
        assert.equal(names.length, 5);
        assert.match(yield* fs.readFileString(`${directory}/rotation.jsonl`), /record 6/);
        assert.match(yield* fs.readFileString(`${directory}/rotation.jsonl.4`), /record 2/);
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  );
});

test("collector exits when its parent is killed", { timeout: 20_000 }, async () => {
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const directory = yield* fs.makeTempDirectoryScoped();
        const child = spawn(
          process.execPath,
          [new URL("./fixtures/local-process.ts", import.meta.url).pathname],
          {
            env: { ...process.env, EXECUTOR_DIAGNOSTICS_TEST_DIR: directory },
            stdio: "ignore",
          },
        );
        const exited = once(child, "exit");
        yield* Effect.addFinalizer(() =>
          Effect.promise(async () => {
            if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
            await exited;
          }),
        );
        const collector = yield* Effect.gen(function* () {
          const statusPath = `${directory}/diagnostics/collector.json`;
          while (true) {
            if (yield* fs.exists(statusPath)) {
              const value = yield* fs
                .readFileString(statusPath)
                .pipe(Effect.flatMap(Schema.decodeUnknownEffect(Collector)));
              if (value.state === "running" && value.pid !== undefined) return value.pid;
            }
            yield* Effect.sleep("100 millis");
          }
        }).pipe(Effect.timeout("10 seconds"));
        child.kill("SIGKILL");
        yield* Effect.promise(() => exited);
        yield* Effect.gen(function* () {
          while (true) {
            try {
              process.kill(collector, 0);
            } catch (error) {
              if (error instanceof Error && "code" in error && error.code === "ESRCH") return;
              throw error;
            }
            yield* Effect.sleep("100 millis");
          }
        }).pipe(Effect.timeout("5 seconds"));
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  );
});

test(
  "telemetry starts before a delayed collector and exports after it becomes ready",
  { timeout: 20_000 },
  async () => {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const directory = yield* fs.makeTempDirectoryScoped();
          const bundle = path.join(directory, "bundle");
          const gate = path.join(directory, "continue");
          const executable = process.platform === "win32" ? "bun.exe" : "bun";
          yield* fs.makeDirectory(path.join(bundle, "src"), { recursive: true });
          yield* fs.copyFile(
            yield* path.fromFileUrl(new URL(`../dist/motel/${executable}`, import.meta.url)),
            path.join(bundle, executable),
          );
          yield* fs.chmod(path.join(bundle, executable), 0o755);
          yield* fs.writeFileString(
            path.join(bundle, "src/executor-server.ts"),
            `while (!(await Bun.file(${JSON.stringify(gate)}).exists())) await Bun.sleep(25); await import(${JSON.stringify(new URL("../dist/motel/src/executor-server.ts", import.meta.url).href)});`,
          );
          const runtime = ManagedRuntime.make(
            localTelemetry(directory, "delayed-test").pipe(
              Layer.provide(NodeServices.layer),
              Layer.provide(
                Layer.succeed(
                  ConfigProvider.ConfigProvider,
                  ConfigProvider.fromUnknown({ EXECUTOR_MOTEL_BUNDLE: bundle }),
                ),
              ),
            ),
          );
          yield* Effect.addFinalizer(() => Effect.promise(() => runtime.dispose()));
          // Readiness is impossible until this call returns and opens the test gate.
          yield* Effect.promise(() =>
            runtime.runPromise(
              Effect.logInfo("startup before Motel").pipe(Effect.withSpan("startup.before-motel")),
            ),
          ).pipe(Effect.timeout("2 seconds"));
          yield* fs.writeFileString(gate, "ready");
          yield* Effect.promise(() =>
            runtime.runPromise(Effect.flatMap(OtlpExporter.Flusher, (flusher) => flusher.flush)),
          );
          const state = yield* fs
            .readFileString(path.join(directory, "diagnostics/collector.json"))
            .pipe(Effect.flatMap(Schema.decodeUnknownEffect(Collector)));
          assert.equal(state.state, "running");
          assert.ok(state.url);
          const now = BigInt(Date.now()) * 1_000_000n;
          yield* Effect.promise(() =>
            runtime.runPromise(
              forwardTelemetry(
                {
                  traces: [
                    JSON.stringify({
                      resourceSpans: [
                        {
                          scopeSpans: [
                            {
                              spans: [
                                {
                                  traceId: "ab".repeat(16),
                                  spanId: "cd".repeat(8),
                                  name: "browser.relay.ready",
                                  startTimeUnixNano: String(now),
                                  endTimeUnixNano: String(now + 1_000_000n),
                                },
                              ],
                            },
                          ],
                        },
                      ],
                    }),
                  ],
                  logs: [],
                  dropped: 0,
                },
                undefined,
                undefined,
                "executor-web",
              ),
            ),
          );
          const traces = yield* Effect.promise(() =>
            fetch(`${state.url}/api/traces`).then((r) => r.text()),
          );
          assert.match(traces, /startup.before-motel/);
          assert.match(traces, /browser.relay.ready/);
        }),
      ).pipe(Effect.provide(NodeServices.layer)),
    );
  },
);
