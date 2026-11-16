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
 *
 * Runs it keeps are shrunk: their bulk is removed and the rest stays. Bulk is each target's
 * (`local`, `self-host`, `cloud`) `coverage/` and `data/` folders and every `data/` folder under
 * its `scenarios/<id>/`: the product databases, Cloud's diagnostics SQLite and the raw coverage
 * reports, most of a run's bytes. On the shared host no file in them was read more than an hour
 * after its run ended, while `server.log`, the reports, evidence files, traces, videos and
 * screenshots were; those stay. A passed run is shrunk as soon as a newer passed run exists; any
 * other run 24 hours after it ended (its `evidence.json` was written, or its folder last changed).
 * A shrunk run holds `shrunk.json`, naming what was removed and when; with no bulk left, a later
 * start passes it by.
 *
 * A `keep-all-runs` file in `.local/e2e` turns removal and shrinking off for the workspace, for
 * someone investigating; the host's evidence sweep honours it too.
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
/** A run other than a passed one keeps its bulk this long after it ended. */
const shrinkAfterMs = 24 * 60 * 60_000;
/** In `.local/e2e`: keep every run whole. */
export const keepAllMarker = "keep-all-runs";
/** In a shrunk run folder: what was removed and when. */
export const shrunkMarker = "shrunk.json";
const targets = ["local", "self-host", "cloud"] as const;

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
    if (yield* fs.exists(path.join(root, keepAllMarker)))
      return yield* Console.log(`e2e: kept every run: ${path.join(root, keepAllMarker)} is set.`);

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
    const counted = new Set<string>();
    const sizeOf = (file: string, seen = counted): Effect.Effect<number> =>
      Effect.gen(function* () {
        if (Option.isSome(yield* Effect.option(fs.readLink(file)))) return 0;
        const info = yield* fs.stat(file);
        if (info.type === "Directory") {
          let total = 0;
          for (const name of yield* fs.readDirectory(file))
            total += yield* sizeOf(path.join(file, name), seen);
          return total;
        }
        const inode = `${info.dev}:${Option.getOrElse(info.ino, () => file)}`;
        if (seen.has(inode)) return 0;
        seen.add(inode);
        return Option.match(info.blocks, {
          onNone: () => Number(info.size),
          // Effect 4.1 gives the block count as a bigint.
          onSome: (blocks) => Number(blocks) * 512,
        });
      }).pipe(Effect.orElseSucceed(() => 0));

    /** A real directory, not a link to one. */
    const isDirectory = (file: string) =>
      Effect.gen(function* () {
        if (Option.isSome(yield* Effect.option(fs.readLink(file)))) return false;
        return (yield* fs.stat(file)).type === "Directory";
      }).pipe(Effect.orElseSucceed(() => false));

    /** The run's bulk folders, relative to it: see the comment at the top. */
    const bulkOf = (directory: string) =>
      Effect.gen(function* () {
        const found: Array<string> = [];
        const dataUnder = (relative: string): Effect.Effect<void> =>
          Effect.gen(function* () {
            for (const name of yield* fs.readDirectory(path.join(directory, relative))) {
              const child = path.join(relative, name);
              if (!(yield* isDirectory(path.join(directory, child)))) continue;
              if (name === "data") found.push(child);
              else yield* dataUnder(child);
            }
          }).pipe(Effect.orElseSucceed(() => undefined));
        for (const target of targets) {
          if (!(yield* isDirectory(path.join(directory, target)))) continue;
          for (const name of ["coverage", "data"])
            if (yield* isDirectory(path.join(directory, target, name)))
              found.push(path.join(target, name));
          const scenarios = path.join(target, "scenarios");
          if (yield* isDirectory(path.join(directory, scenarios))) yield* dataUnder(scenarios);
        }
        return found;
      });

    /** When the run ended: its `evidence.json` was written, or else its folder last changed. */
    const endedAt = (directory: string) =>
      fs.stat(path.join(directory, "evidence.json")).pipe(
        Effect.catch(() => fs.stat(directory)),
        Effect.map((info) =>
          Option.getOrElse(
            Option.map(info.mtime, (date) => date.getTime()),
            () => now,
          ),
        ),
        Effect.orElseSucceed(() => now),
      );

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
    type Run = {
      directory: string;
      passed: boolean;
      size: number;
      ended: number;
    };
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
        runs.push({
          directory,
          passed: yield* passed(directory),
          size: yield* sizeOf(directory),
          ended: yield* endedAt(directory),
        });
    }
    // Shrink before sizing against the cap, so the cap counts what stays.
    const newestPassed = runs.find((run) => run.passed);
    const shrinking = new Map<Run, { bulk: Array<string>; bytes: number; reason: string }>();
    for (const run of runs) {
      const reason = run.passed
        ? run === newestPassed
          ? undefined
          : "passed, and a newer passed run exists"
        : now - run.ended > shrinkAfterMs
          ? "not passed, and ended more than 24 hours ago"
          : undefined;
      if (reason === undefined) continue;
      const bulk = yield* bulkOf(run.directory);
      if (bulk.length === 0) continue;
      const seen = new Set<string>();
      let bytes = 0;
      for (const relative of bulk) bytes += yield* sizeOf(path.join(run.directory, relative), seen);
      shrinking.set(run, { bulk, bytes, reason });
      run.size = Math.max(0, run.size - bytes);
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
    const shrinks = [...shrinking].filter(([run]) => !removed.has(run));
    if (doomed.length === 0 && shrinks.length === 0) return;

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
    let shrunk = 0;
    for (const [run, plan] of shrinks) {
      if (yield* inProgress(run.directory)) continue;
      const done: Array<string> = [];
      for (const relative of plan.bulk) {
        const target = path.join(run.directory, relative);
        // Checked again just before: a real directory inside this run folder, not a link.
        const resolved = yield* Effect.option(fs.realPath(target));
        if (
          Option.isNone(resolved) ||
          resolved.value !== path.join(real, path.relative(root, target))
        )
          continue;
        const result = yield* Effect.result(fs.remove(target, { recursive: true, force: true }));
        if (result._tag === "Failure")
          failed.push(`${path.basename(run.directory)}/${relative}: ${result.failure.message}`);
        else done.push(relative);
      }
      if (done.length === 0) continue;
      const marker = yield* Effect.result(
        fs.writeFileString(
          path.join(run.directory, shrunkMarker),
          `${JSON.stringify({ shrunkAt: new Date().toISOString(), reason: plan.reason, removed: done, note: "Removed by e2e/sdk/run-retention.ts: product databases, diagnostics and raw coverage. Logs, reports and evidence files remain." }, null, 2)}\n`,
        ),
      );
      if (marker._tag === "Failure")
        failed.push(`${path.basename(run.directory)}/${shrunkMarker}: ${marker.failure.message}`);
      shrunk++;
    }
    const after = yield* free;
    const space =
      Option.isSome(before) && Option.isSome(after)
        ? ` (${Math.max(0, Math.round((after.value - before.value) / 1024 ** 2))} MB freed)`
        : "";
    if (shrunk > 0)
      yield* Console.log(
        `e2e: shrank ${shrunk} older ${shrunk === 1 ? "run" : "runs"} in ${root}: removed product databases, diagnostics and raw coverage (passed runs once a newer one passed, others a day after they ended); logs, reports and evidence stay. Each says so in ${shrunkMarker}. Keep every run whole with: touch ${path.join(root, keepAllMarker)}`,
      );
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
