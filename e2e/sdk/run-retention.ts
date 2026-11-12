/**
 * Each local suite run writes a run folder under the workspace's `.local/e2e`, and nothing else
 * removes them: on the shared host they reached 107 GB over 283 workspaces. When a run starts it
 * removes older run folders in its own workspace:
 *
 * - any run started more than `keepMs` ago;
 * - passed runs past the newest `keepPassedRuns`. A run with a failed scenario, or whose outcome
 *   cannot be read (it crashed, was stopped or timed out), is kept for its failure evidence;
 * - then, while the rest exceed `defaultKeepBytes`, passed runs oldest first, then the others oldest first.
 *
 * A run passed only when its `evidence.json` says `"outcome": "passed"`, which `runSuite` writes
 * from the same checks that fail the run. Runs saved before that field, and runs whose outcome
 * cannot be read, count as not passed.
 *
 * The start time comes from the folder's name. A folder whose name is not a real time is kept and
 * left out of the count and the size, as are runs in progress. A system clock set more than three
 * days ahead would make every finished run look old.
 *
 * A run (or a render of one) holds an `in-progress-*.json` marker naming its PID while it writes,
 * and a folder with a marker whose process is alive is never removed, whatever its age. A marker
 * left by a killed run names a PID that is gone, so its folder is pruned like any other.
 *
 * Only folders named like a run directly in `.local/e2e` are candidates. A symbolic link there,
 * or a `.local/e2e` that is a link, is left alone and never followed; removal never follows links
 * inside a run folder either. `runSuite` does not prune in CI: one job runs several suites in a
 * fresh checkout, then uploads and collects coverage from every run folder.
 */
import { Cause, Console, Effect, FileSystem, Option, Path, Schema } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { randomBytes } from "node:crypto";
import { alive } from "../host-slot.ts";

/**
 * Run folders measured 2-190 MB, 30 MB on average over 3,575 runs; a local run is about 120 MB.
 * Agents compare a run with the one or two before a fix, often across two targets, within a day or
 * two, and prove a fix by looping one scenario 20 times and reading only the failures afterwards.
 * 3 GB holds such a loop on local with every run failed (2.4 GB) beside five passed runs.
 */
const keepPassedRuns = 5;
const keepMs = 3 * 24 * 60 * 60_000;
const defaultKeepBytes = 3 * 1024 ** 3;

/** The outcome `runSuite` records in a run's `evidence.json`. */
const Outcome = Schema.fromJsonString(
  Schema.Struct({ outcome: Schema.optional(Schema.Literals(["passed", "failed"])) }),
);

/** `2026-11-12T19-04-07.123Z-cloud-1a2b3c`, as `runSuite` names a run; older runs lack the suffix. */
const runName =
  /^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2}\.\d{3})Z-(?:self-host|local|cloud|all|hosted)(?:-[0-9a-f]{6})?$/;
const markerPrefix = "in-progress-";

/** Marks a run folder as being written for the enclosing scope. */
export const holdRun = (directory: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem,
      path = yield* Path.Path;
    const marker = path.join(
      directory,
      `${markerPrefix}${process.pid}-${randomBytes(3).toString("hex")}.json`,
    );
    yield* Effect.acquireRelease(
      fs.writeFileString(
        marker,
        JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }),
      ),
      () => Effect.ignore(fs.remove(marker)),
    );
  });

/**
 * Removes old run folders in `workspace`'s `.local/e2e` beside `current`, the run starting now.
 * Reports, never fails. `keepBytes` is a parameter only so a check can use a small cap.
 */
export const pruneRuns = ({
  workspace,
  current,
  keepBytes = defaultKeepBytes,
}: {
  readonly workspace: string;
  readonly current: string;
  readonly keepBytes?: number;
}) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem,
      path = yield* Path.Path,
      processes = yield* ChildProcessSpawner.ChildProcessSpawner;
    const root = path.join(workspace, ".local/e2e");
    const real = yield* fs.realPath(root);
    if (real !== path.join(yield* fs.realPath(workspace), ".local", "e2e"))
      return yield* Console.error(`e2e: kept old runs: ${root} is or is under a symbolic link.`);

    /** True while a live process holds a marker, or when a marker cannot be read. */
    const inProgress = (directory: string) =>
      Effect.gen(function* () {
        for (const name of yield* fs.readDirectory(directory)) {
          if (!name.startsWith(markerPrefix) || !name.endsWith(".json")) continue;
          const pid = yield* fs.readFileString(path.join(directory, name)).pipe(
            Effect.flatMap((text) => Effect.try(() => (JSON.parse(text) as { pid?: unknown }).pid)),
            Effect.orElseSucceed(() => undefined),
          );
          // `process.kill` throws on a PID that is not a positive integer, which reads as gone.
          if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0 || alive(pid))
            return true;
        }
        return false;
      }).pipe(Effect.orElseSucceed(() => true));

    /**
     * Bytes allocated under `file`, without following links and counting each inode once. A file
     * that cannot be read, or vanishes while another run writes, counts as nothing.
     */
    const seen = new Set<string>();
    const sizeOf = (file: string): Effect.Effect<number> =>
      Effect.gen(function* () {
        if (Option.isSome(yield* Effect.option(fs.readLink(file)))) return 0;
        const info = yield* fs.stat(file);
        if (info.type === "Directory") {
          let total = 0;
          for (const name of yield* fs.readDirectory(file))
            total += yield* sizeOf(path.join(file, name));
          return total;
        }
        const inode = `${info.dev}:${Option.getOrElse(info.ino, () => file)}`;
        if (seen.has(inode)) return 0;
        seen.add(inode);
        return Option.match(info.blocks, {
          onNone: () => Number(info.size),
          onSome: (blocks) => blocks * 512,
        });
      }).pipe(Effect.orElseSucceed(() => 0));

    /** Only an outcome `runSuite` recorded as passed. */
    const passed = (directory: string) =>
      fs.readFileString(path.join(directory, "evidence.json")).pipe(
        Effect.flatMap(Schema.decodeUnknownEffect(Outcome)),
        Effect.map((report) => report.outcome === "passed"),
        Effect.orElseSucceed(() => false),
      );

    /** Free bytes on the workspace's file system, from POSIX `df`; none if it hangs, as on a stale mount. */
    const free = processes.string(ChildProcess.make("df", ["-Pk", root])).pipe(
      Effect.map((text) => Number(text.trim().split("\n").at(-1)?.split(/\s+/)[3]) * 1024),
      Effect.timeout("3 seconds"),
      Effect.option,
      Effect.map(Option.filter(Number.isFinite)),
    );

    const now = Date.now();
    const names = (yield* fs.readDirectory(root)).filter((name) => runName.test(name)).sort();
    type Run = { directory: string; passed: boolean; size: number };
    const aged: Array<string> = [];
    // Finished runs from the last 3 days, newest first.
    const runs: Array<Run> = [];
    for (const name of names.reverse()) {
      const directory = path.join(root, name);
      // A link resolves elsewhere (or nowhere): leave it and what it points to.
      const resolved = yield* Effect.option(fs.realPath(directory));
      if (Option.isNone(resolved) || resolved.value !== path.join(real, name)) continue;
      const [, day, hours, minutes, seconds] = runName.exec(name) ?? [];
      const time = `${day}T${hours}:${minutes}:${seconds}Z`;
      const started = Date.parse(time);
      // Not a real time (hour 25, 30 February): keep it, uncounted.
      if (!Number.isFinite(started) || new Date(started).toISOString() !== time) continue;
      if (name === current || (yield* inProgress(directory))) continue;
      if (now - started > keepMs) aged.push(directory);
      else
        runs.push({ directory, passed: yield* passed(directory), size: yield* sizeOf(directory) });
    }
    const removed = new Set(runs.filter((run) => run.passed).slice(keepPassedRuns));
    let bytes = runs.filter((run) => !removed.has(run)).reduce((sum, run) => sum + run.size, 0);
    const oldestFirst = runs.filter((run) => !removed.has(run)).reverse();
    for (const run of [
      ...oldestFirst.filter((run) => run.passed),
      ...oldestFirst.filter((run) => !run.passed),
    ]) {
      if (bytes <= keepBytes) break;
      removed.add(run);
      bytes -= run.size;
    }
    const doomed = [...aged, ...runs.filter((run) => removed.has(run)).map((run) => run.directory)];
    if (doomed.length === 0) return;

    const before = yield* free;
    let count = 0;
    const failed: Array<string> = [];
    for (const directory of doomed) {
      // A render may have started on it since the scan. One starting between this read and the
      // removal still loses the folder; only folders already condemned are at stake.
      if (yield* inProgress(directory)) continue;
      const result = yield* Effect.result(fs.remove(directory, { recursive: true, force: true }));
      if (result._tag === "Failure")
        failed.push(`${path.basename(directory)}: ${result.failure.message}`);
      else count++;
    }
    const after = yield* free;
    const space =
      Option.isSome(before) && Option.isSome(after)
        ? ` (${Math.max(0, Math.round((after.value - before.value) / 1024 ** 2))} MB freed)`
        : "";
    if (count > 0)
      yield* Console.log(
        `e2e: removed ${count} old ${count === 1 ? "run" : "runs"}${space} from ${root}. It keeps runs from the last 3 days: the newest ${keepPassedRuns} passed, every other one, up to ${keepBytes >= 1024 ** 3 ? `${keepBytes / 1024 ** 3} GB` : `${Math.round(keepBytes / 1024 ** 2)} MB`}.`,
      );
    if (failed.length > 0)
      yield* Console.error(
        `e2e: could not remove ${failed.length} old ${failed.length === 1 ? "run" : "runs"} (${failed[0]}); the run goes on.`,
      );
  }).pipe(
    Effect.catchCause((cause) =>
      Console.error(
        `e2e: could not prune old runs: ${Cause.pretty(cause).split("\n")[0]}; the run goes on.`,
      ),
    ),
  );
