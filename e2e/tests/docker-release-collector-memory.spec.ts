/**
 * The telemetry collector runs in its own workerd process and shares the container's memory limit.
 * Every export it stores leaves garbage in its isolate. Without memory settings, workerd does not
 * collect an idle isolate or return freed memory to the system, so under a steady stream of
 * scheduled apps' spans the collector grew by about 100 MB an hour to about 430 MB. Its process
 * now collects the isolate once it has been idle for 2 seconds and returns what that frees. In
 * seven runs of the 4 exports below it gave back about three quarters to nine tenths of what they
 * took, in readings taken about 3 to 5 seconds after the last export. Six runs on beta.40 were
 * read for up to a minute: one reached about 53% back, at 59 seconds, and the other five had
 * given back about a fifth or less when the minute ended. Six more, read for the 20 seconds
 * allowed here, gave back none in five runs and about a fifth in one.
 */
import { expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { Config, Console, Effect, Exit, Schedule, Schema } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { randomBytes } from "node:crypto";

const exportCount = 4;
const spansPerExport = 12_000;
const spansPerTrace = 30;

/**
 * Runs in a container that shares the image's process namespace, as the user the server runs
 * as. It finds the collector's Unix socket through its process and sends it the exports one after
 * another. It reads the collector's resident memory, in KiB, before the first export, every 50 ms
 * while they are stored to keep the highest reading, and then until the collector has returned
 * half of what the exports took or 20 seconds have passed since the last was answered. It
 * prints how long after that answer its last reading was taken. Every reading is of the process
 * that was the collector at the start: a collector that exits or restarts fails the run. Last, it
 * asks the collector for the traces it stored. It prints its readings, or the failure that
 * stopped it.
 */
const burst = `const fs = require("node:fs");
const http = require("node:http");
const crypto = require("node:crypto");
(async () => {
  // The name is joined here so this script's own command line does not hold it.
  const collectors = fs.readdirSync("/proc").filter((p) => Number.isInteger(Number(p))).filter((p) => {
    try { return fs.readFileSync("/proc/" + p + "/cmdline", "utf8").includes(["motel", "capnp"].join(".")); } catch { return false; }
  });
  if (collectors.length !== 1) throw new Error("expected one collector process, found " + collectors.length);
  const pid = collectors[0];
  const tmp = "/proc/" + pid + "/root/tmp";
  const socketPath = fs.readdirSync(tmp).filter((name) => name.startsWith("executor-host-")).map((name) => tmp + "/" + name + "/motel.sock").find((path) => fs.existsSync(path));
  // A process's start time is field 22 of its stat line. Another process that takes the id has another.
  const startTime = () => {
    const stat = fs.readFileSync("/proc/" + pid + "/stat", "utf8");
    return stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19];
  };
  const started = startTime();
  const resident = () => {
    let status;
    try {
      if (startTime() !== started) throw new Error("another process has its id");
      status = fs.readFileSync("/proc/" + pid + "/status", "utf8");
    } catch (cause) { throw new Error("the collector's process is gone: " + cause.message); }
    const line = status.split("\\n").find((entry) => entry.startsWith("VmRSS:"));
    const kib = line === undefined ? NaN : Number(line.replace("VmRSS:", "").trim().split(" ")[0]);
    if (!(kib > 0)) throw new Error("the collector's resident memory could not be read");
    return kib;
  };
  const id = (bytes) => crypto.randomBytes(bytes).toString("hex");
  const body = () => {
    const spans = [];
    const start = BigInt(Date.now()) * 1000000n;
    for (let trace = 0; trace < ${spansPerExport} / ${spansPerTrace}; trace++) {
      const traceId = id(16), root = id(8);
      for (let step = 0; step < ${spansPerTrace}; step++)
        spans.push({
          traceId, spanId: step === 0 ? root : id(8), parentSpanId: step === 0 ? "" : root,
          name: step === 0 ? "schedule.dispatch" : "sql.execute", kind: 1,
          startTimeUnixNano: String(start + BigInt(step * 1000)), endTimeUnixNano: String(start + BigInt(step * 1000 + 500)),
          attributes: [
            { key: "db.query.text", value: { stringValue: "SELECT * FROM notes WHERE id = ? AND owner = ? -- " + id(150) } },
            { key: "app.step", value: { intValue: String(step) } },
          ],
        });
    }
    return JSON.stringify({ resourceSpans: [{ resource: { attributes: [{ key: "service.name", value: { stringValue: "collector-memory" } }] }, scopeSpans: [{ scope: { name: "collector-memory" }, spans }] }] });
  };
  const ask = (method, path, payload) => new Promise((resolve, reject) => {
    const request = http.request({ socketPath, path, method, headers: payload === undefined ? {} : { "content-type": "application/json" } }, (response) => {
      let text = "";
      response.on("data", (chunk) => (text += chunk));
      response.on("end", () => response.statusCode === 200 ? resolve(JSON.parse(text)) : reject(new Error(method + " " + path + " answered " + response.statusCode + " " + text)));
    });
    request.on("error", reject);
    request.end(payload);
  });
  const payloads = Array.from({ length: ${exportCount} }, body);
  const before = resident();
  let peak = before;
  let lost;
  const watch = setInterval(() => { try { peak = Math.max(peak, resident()); } catch (cause) { lost = cause; } }, 50);
  let inserted = 0;
  try {
    for (const payload of payloads) {
      inserted += (await ask("POST", "/v1/traces", payload)).insertedSpans;
      peak = Math.max(peak, resident());
    }
  } finally { clearInterval(watch); }
  if (lost !== undefined) throw lost;
  const answered = Date.now();
  const returned = before + (peak - before) / 2;
  let after = resident();
  let waitedMs = Date.now() - answered;
  while (after >= returned && waitedMs < 20000) {
    await new Promise((resolve) => setTimeout(resolve, 500));
    after = resident();
    waitedMs = Date.now() - answered;
  }
  const stats = await ask("GET", "/api/traces/stats?groupBy=operation&agg=count&lookback=1h&limit=12");
  const stored = stats.data.filter((group) => group.group === "schedule.dispatch").reduce((count, group) => count + group.count, 0);
  process.stdout.write(JSON.stringify({ before, peak, after, waitedMs, inserted, stored }));
})().catch((cause) => { process.stdout.write(JSON.stringify({ failure: String(cause && cause.message || cause) })); });`;

/** What the burst printed: its readings in KiB, or why it stopped. */
const Burst = Schema.Union([
  Schema.Struct({ failure: Schema.String }),
  Schema.Struct({
    before: Schema.Number,
    peak: Schema.Number,
    after: Schema.Number,
    waitedMs: Schema.Number,
    inserted: Schema.Number,
    stored: Schema.Number,
  }),
]);

it.live(
  "released image's collector returns the memory a burst of exports used",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const processes = yield* ChildProcessSpawner.ChildProcessSpawner;
        const image = yield* Config.String("EXECUTOR_E2E_DOCKER_IMAGE");
        const run = (args: readonly string[], env: Record<string, string> = {}) =>
          processes.string(ChildProcess.make("docker", args, { env, extendEnv: true }));
        const id = `executor-collector-memory-${randomBytes(6).toString("hex")}`;
        const environment: Record<string, string> = {
          DO_NOT_TRACK: "1",
          PORT: "8080",
          BETTER_AUTH_URL: "http://localhost:8080",
          BETTER_AUTH_SECRET: randomBytes(32).toString("hex"),
          EXECUTOR_ENCRYPTION_KEY: randomBytes(32).toString("hex"),
        };
        yield* Effect.acquireRelease(
          run(
            [
              "run",
              "--detach",
              "--name",
              id,
              "--init",
              ...Object.keys(environment).flatMap((key) => ["--env", key]),
              image,
            ],
            environment,
          ),
          () => run(["rm", "--force", "--volumes", id]).pipe(Effect.orDie),
        );
        // The image logs to stderr. Read it with stdout: an unread pipe fills and `docker logs` waits.
        yield* Effect.addFinalizer((exit) =>
          Exit.isFailure(exit)
            ? processes
                .string(ChildProcess.make("docker", ["logs", id], { stderr: "pipe" }), {
                  includeStderr: true,
                })
                .pipe(Effect.flatMap(Console.error), Effect.ignore)
            : Effect.void,
        );
        yield* processes
          .exitCode(
            ChildProcess.make("docker", ["exec", id, "executor-host", "telemetry", "/api/health"]),
          )
          .pipe(
            Effect.filterOrFail(
              (code) => code === 0,
              () => "the collector is not ready",
            ),
            Effect.retry({ schedule: Schedule.spaced("250 millis"), times: 240 }),
          );
        const burstOutput = yield* run([
          "run",
          "--rm",
          "--pid",
          `container:${id}`,
          "--user",
          "1000",
          "node:24-bookworm-slim",
          "node",
          "-e",
          burst,
        ]).pipe(Effect.flatMap(Schema.decodeUnknownEffect(Schema.fromJsonString(Burst))));
        if ("failure" in burstOutput) return expect.fail(burstOutput.failure);
        const megabytes = (kib: number) => Math.round(kib / 1024);
        yield* Console.log(
          `The collector's resident memory was ${megabytes(burstOutput.before)} MB before the exports, ` +
            `${megabytes(burstOutput.peak)} MB at its highest and ${megabytes(burstOutput.after)} MB ` +
            `${Math.round(burstOutput.waitedMs / 1000)} s after the last was answered.`,
        );
        expect(burstOutput.inserted).toBe(exportCount * spansPerExport);
        const used = burstOutput.peak - burstOutput.before;
        expect(used, "the exports raised the collector's resident memory").toBeGreaterThan(
          64 * 1024,
        );
        // With the collection after 2 seconds idle, the collector returned about three quarters of
        // it or more in readings taken about 3 to 5 seconds after the last export. Without it, one
        // run reached just over half at 59 seconds and five had returned about a fifth or less
        // when a minute ended.
        expect(
          burstOutput.after,
          `${Math.round(burstOutput.waitedMs / 1000)} s after the exports the collector still held ${megabytes(burstOutput.after - burstOutput.before)} of the ${megabytes(used)} MB they used`,
        ).toBeLessThan(burstOutput.before + used / 2);
        expect(
          burstOutput.waitedMs,
          "the reading that showed the memory returned was taken within 20 seconds",
        ).toBeLessThanOrEqual(20_000);
        expect(
          burstOutput.stored,
          "the collector reads back the traces it stored",
        ).toBeGreaterThanOrEqual((exportCount * spansPerExport) / spansPerTrace);
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  240_000,
);
