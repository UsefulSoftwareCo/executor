import { Deferred, Effect, Fiber, Ref, Stream } from "effect";
import type { ChildProcessSpawner } from "effect/process";

export const outputLines = (child: ChildProcessSpawner.ChildProcessHandle) =>
  Stream.merge(
    child.stdout.pipe(Stream.decodeText(), Stream.splitLines),
    child.stderr.pipe(Stream.decodeText(), Stream.splitLines),
  );

const alchemyDevFailures = [
  "alchemy dev: apply failed;",
  "alchemy dev: apply was interrupted internally",
  "alchemy dev: run failed;",
  "alchemy dev: run was interrupted internally",
];

export const isAlchemyDevFailure = (line: string) =>
  alchemyDevFailures.some((prefix) => line.startsWith(prefix));

export const alchemyResourceFailure = (line: string) => {
  const match =
    /^\[[^\]]+\] \w+ \(#\d+\): \[([^\]]+)\] fail\b[^—]*—\s*(.*?)(?: \(\d+(?:\.\d+)?m?s\))?$/.exec(
      line,
    );
  return match === null ? undefined : { resource: match[1] ?? "", reason: match[2] ?? "" };
};

export const unboundPort = (reason: string) => {
  const match = /^Could not bind to port (\d+) /.exec(reason);
  return match === null ? undefined : Number(match[1]);
};

const reportLines = 40;

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
