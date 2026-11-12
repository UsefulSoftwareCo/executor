import { Deferred, Effect, Fiber, Ref, Stream } from "effect";
import type { ChildProcessSpawner } from "effect/process";

/**
 * Every line a child prints, whole. Each pipe is decoded and split on its own before the two are
 * merged: merging the bytes first would splice a line written in pieces to one pipe with whatever
 * the other pipe wrote in between.
 */
export const outputLines = (child: ChildProcessSpawner.ChildProcessHandle) =>
  Stream.merge(
    child.stdout.pipe(Stream.decodeText(), Stream.splitLines),
    child.stderr.pipe(Stream.decodeText(), Stream.splitLines),
  );

/**
 * How `alchemy dev` starts the line it prints when it gives up on an apply or a whole run
 * (`describeFailure` in alchemy's src/Cli/exec.ts): either step failed, or it ended with nothing
 * but interruptions. Either way dev keeps running and retries only after a source file changes,
 * which never happens in a run.
 */
const alchemyDevFailures = [
  "alchemy dev: apply failed;",
  "alchemy dev: apply was interrupted internally",
  "alchemy dev: run failed;",
  "alchemy dev: run was interrupted internally",
];

/** Whether `line` is `alchemy dev` reporting that it gave up on starting a resource. */
export const isAlchemyDevFailure = (line: string) =>
  alchemyDevFailures.some((prefix) => line.startsWith(prefix));

/**
 * The resource and reason when `line` is `alchemy dev` reporting that one resource failed, such as
 * `[07:42:09.266] INFO (#3608): [AppPages] fail (local) — Could not bind to port 23558 (already
 * in use). (10ms)`. The apply's failure line that follows names no resource, so a start failure
 * quotes these instead.
 */
export const alchemyResourceFailure = (line: string) => {
  const match =
    /^\[[^\]]+\] \w+ \(#\d+\): \[([^\]]+)\] fail\b[^—]*—\s*(.*?)(?: \(\d+(?:\.\d+)?m?s\))?$/.exec(
      line,
    );
  return match === null ? undefined : { resource: match[1] ?? "", reason: match[2] ?? "" };
};

/** The port a resource failure reports it could not bind, which `ss` can then name the holder of. */
export const unboundPort = (reason: string) => {
  const match = /^Could not bind to port (\d+) /.exec(reason);
  return match === null ? undefined : Number(match[1]);
};

/** The most lines of alchemy's report a start failure quotes; cloud.log keeps all of them. */
const reportLines = 40;

/**
 * Follow `alchemy dev`'s output, passing each line to `onLine`. `failed` completes when alchemy
 * reports giving up. The report, the cause alchemy prints right after that line, arrives in the
 * same write, but the line that says it gave up is read first: a start that failed on that line
 * alone stopped reading before the report and lost it. `report` stops alchemy, which would only
 * wait for a file change, reads its output to the end, so `onLine` has seen every line, and
 * returns the report.
 */
export const followAlchemyDev = (
  child: ChildProcessSpawner.ChildProcessHandle,
  onLine: (line: string) => Effect.Effect<void>,
) =>
  Effect.gen(function* () {
    const failed = yield* Deferred.make<void>();
    const report = yield* Ref.make<ReadonlyArray<string>>([]);
    const reading = yield* outputLines(child).pipe(
      Stream.runForEach((line) =>
        onLine(line).pipe(
          Effect.andThen(
            Effect.gen(function* () {
              if (yield* Deferred.isDone(failed)) {
                yield* Ref.update(report, (lines) =>
                  lines.length < reportLines ? [...lines, line] : lines,
                );
              } else if (isAlchemyDevFailure(line)) {
                yield* Ref.set(report, [line]);
                yield* Deferred.succeed(failed, undefined);
              }
            }),
          ),
        ),
      ),
      Effect.forkScoped,
    );
    return {
      failed: Deferred.await(failed),
      report: child.kill({ forceKillAfter: "15 seconds" }).pipe(
        Effect.ignore,
        Effect.andThen(Fiber.join(reading)),
        Effect.ignore,
        Effect.andThen(Ref.get(report)),
        Effect.map((lines) => lines.join("\n")),
      ),
    };
  });
