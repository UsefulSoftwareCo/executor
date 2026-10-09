/**
 * `alchemy dev`'s sidecar starts every local Worker's watcher at once, and the alchemy patch makes
 * their first builds take turns (patches/alchemy.md). A turn must not outlive what it guards: a
 * Worker that stops while it waits leaves the queue at once, a watcher that fails to set up gives
 * its turn back, and a first build that hangs holds its turn for one minute at most.
 *
 * Each case runs a probe against the alchemy Cloud installs, with rolldown building two one-line
 * modules: under Node, which loads the patched `lib/`, and under Bun, which loads the patched `src/`
 * and runs the dev sidecar when `alchemy dev` runs under Bun. A plugin's `buildStart` hook holds a
 * build or records that it started. The probe must exit by itself: a watcher left open keeps it
 * alive.
 */
import { expect, layer } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { Effect, FileSystem, Option, Path, Schema, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

/** How long a first build may hold its turn, as the patch states it. */
const turnLimit = 60_000;

const probe = `
const [dir, scenario] = process.argv.slice(1);
const realSetTimeout = globalThis.setTimeout;
// In the hung case the turn's own timer fires after 300 ms, so the build need not hang a minute.
const shortened = [];
globalThis.setTimeout = (callback, delay, ...rest) => {
  if (scenario === "hung" && delay === ${turnLimit}) {
    shortened.push(delay);
    return realSetTimeout(callback, 300, ...rest);
  }
  return realSetTimeout(callback, delay, ...rest);
};
const { Effect, Stream } = await import("effect");
const { watch } = await import("alchemy/Bundle");
const sleep = (ms) => new Promise((resolve) => realSetTimeout(resolve, ms));
const until = async (check, ms) => {
  for (let waited = 0; !check() && waited < ms; waited += 20) await sleep(20);
  return check();
};
/** A plugin whose build waits for release(), or records that it started when not held. */
const hook = (held) => {
  let release = () => {};
  const gate = held ? new Promise((resolve) => (release = resolve)) : undefined;
  const state = { started: false, release: () => release() };
  state.plugin = {
    name: "probe",
    async buildStart() {
      state.started = true;
      await gate;
    },
  };
  return state;
};
const run = (name, plugin, extra) => {
  const controller = new AbortController();
  const events = [];
  let settled = false;
  const exit = Effect.runPromiseExit(
    Stream.runForEach(
      watch({ input: dir + "/" + name + ".js", plugins: [plugin] }, { dir: dir + "/out-" + name, format: "es" }, extra),
      (event) => Effect.sync(() => events.push(event._tag)),
    ),
    { signal: controller.signal },
  ).then(() => (settled = true));
  return { events, settled: () => settled, stop: () => (controller.abort(), exit) };
};
const report = {};
if (scenario === "queued") {
  const first = hook(true);
  const a = run("a", first.plugin);
  await until(() => first.started, 10_000);
  const second = hook(false);
  const b = run("b", second.plugin);
  await sleep(500);
  report.secondStartedWhileFirstBuilds = second.started;
  b.stop();
  report.queuedStopSettled = await until(b.settled, 1_000);
  first.release();
  report.firstBuilt = await until(() => a.events.includes("Success"), 10_000);
  await sleep(500);
  report.stoppedSecondStarted = second.started;
  await a.stop();
} else if (scenario === "setup") {
  // An empty pure-annotation package pattern makes the watcher's setup throw.
  const a = run("a", hook(false).plugin, { pure: { replaceDefaults: true, packages: [""] } });
  await sleep(200);
  const second = hook(false);
  const b = run("b", second.plugin);
  report.secondStarted = await until(() => second.started, 10_000);
  report.secondBuilt = await until(() => b.events.includes("Success"), 10_000);
  report.firstEvents = a.events;
  await Promise.all([a.stop(), b.stop()]);
} else if (scenario === "hung") {
  const first = hook(true);
  const a = run("a", first.plugin);
  await until(() => first.started, 10_000);
  const second = hook(false);
  const b = run("b", second.plugin);
  report.secondStarted = await until(() => second.started, 10_000);
  report.turnTimerFired = shortened.length > 0;
  report.secondBuilt = await until(() => b.events.includes("Success"), 10_000);
  first.release();
  report.firstBuilt = await until(() => a.events.includes("Success"), 10_000);
  await Promise.all([a.stop(), b.stop()]);
}
console.log(JSON.stringify(report));
`;

const runtimes = {
  node: ["--input-type=module", "--eval", probe],
  bun: ["-e", probe],
} as const;

/** Runs one scenario; `exited` is false when the probe was still running after 30 s. */
const scenario = (runtime: keyof typeof runtimes, name: "queued" | "setup" | "hung") =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const processes = yield* ChildProcessSpawner.ChildProcessSpawner;
    const dir = yield* fs.makeTempDirectoryScoped({ prefix: "executor-alchemy-first-builds-" });
    yield* fs.writeFileString(path.join(dir, "a.js"), "export const a = 1;\n");
    yield* fs.writeFileString(path.join(dir, "b.js"), "export const b = 1;\n");
    const child = yield* processes.spawn(
      ChildProcess.make(runtime, [...runtimes[runtime], dir, name], {
        cwd: path.resolve("apps/hosted/cloud"),
      }),
    );
    const result = yield* Effect.all(
      [
        child.stdout.pipe(Stream.decodeText(), Stream.mkString),
        child.stderr.pipe(Stream.decodeText(), Stream.mkString),
        child.exitCode,
      ],
      { concurrency: "unbounded" },
    ).pipe(Effect.timeoutOption("30 seconds"));
    if (Option.isNone(result)) return { exited: false, report: undefined, stderr: "" } as const;
    const [stdout, stderr, exitCode] = result.value;
    expect(exitCode, stderr).toBe(0);
    const report = yield* Schema.decodeUnknownEffect(
      Schema.fromJsonString(Schema.Record(Schema.String, Schema.Json)),
    )(stdout.trim().split("\n").at(-1));
    return { exited: true, report, stderr } as const;
  }).pipe(Effect.scoped);

layer(NodeServices.layer, { excludeTestServices: true })("Alchemy first builds", (it) => {
  for (const runtime of Object.keys(runtimes) as Array<keyof typeof runtimes>) {
    it.effect(
      `a Worker that stops while it waits for a first build leaves the queue at once (${runtime})`,
      () =>
        Effect.gen(function* () {
          const run = yield* scenario(runtime, "queued");
          expect(run.exited, "the probe exits by itself").toBe(true);
          expect(run.report).toEqual({
            secondStartedWhileFirstBuilds: false,
            queuedStopSettled: true,
            firstBuilt: true,
            stoppedSecondStarted: false,
          });
        }),
    );

    it.effect(
      `a watcher that fails to set up reports it and gives its turn back (${runtime})`,
      () =>
        Effect.gen(function* () {
          const run = yield* scenario(runtime, "setup");
          expect(run.exited, "the probe exits by itself").toBe(true);
          expect(run.report).toEqual({
            secondStarted: true,
            secondBuilt: true,
            firstEvents: ["Error"],
          });
        }),
    );

    it.effect(
      `a first build that hangs gives up its turn after one minute and still finishes (${runtime})`,
      () =>
        Effect.gen(function* () {
          const run = yield* scenario(runtime, "hung");
          expect(run.exited, "the probe exits by itself").toBe(true);
          expect(run.report).toEqual({
            secondStarted: true,
            turnTimerFired: true,
            secondBuilt: true,
            firstBuilt: true,
          });
        }),
    );
  }
});
