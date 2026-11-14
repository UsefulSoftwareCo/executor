/**
 * Staple Apple's notarization ticket to an app or a disk image, repeating only a failure to reach
 * Apple's ticket service.
 *
 * `notarizeDiskImages` (macos-signing.ts) staples each disk image with it, and `@electron/notarize`
 * staples the app through it: its patched `stapleApp` runs `node scripts/releases/staple.ts <app>`
 * when `EXECUTOR_STAPLE_SCRIPT` names that file, which the signing environment sets.
 *
 * Stapling fetches the ticket of a submission Apple has already accepted, so repeating it changes
 * nothing at Apple. Since 14 Nov 2026 the Intel macOS leg's staple has lost its connection to the
 * ticket service about half the time (`NSURLErrorDomain` -1005 on the CloudKit lookup), while the
 * Apple Silicon leg's never has. This repeats such a failure, and nothing else:
 *
 * - The first attempt runs `xcrun stapler staple -v` as before: the slice of the calling process,
 *   which on the Intel leg is x86_64 under Rosetta.
 * - It repeats only when the stapler's output names a failure to reach Apple: `NSURLErrorDomain`
 *   -1001 (timed out), -1004 (cannot connect), -1005 (connection lost) or -1009 (offline), or a 5xx
 *   status from the ticket service. Any other failure fails at once.
 * - It waits 10, 20, 40, 80 and 160 s before the five repeats: 310 s of waiting, about five minutes
 *   with the attempts, which outlasts the shorter losses seen and stays well inside the job.
 * - On Apple Silicon hardware (`sysctl -n hw.optional.arm64` is 1, also under Rosetta) the repeats
 *   run the stapler's arm64 slice (`arch -arm64 xcrun stapler …`), so the log shows whether that
 *   slice reaches Apple where the x86_64 one did not.
 * - Each attempt that could not reach Apple prints its full stapler output, in a group named by its
 *   attempt and slice, then a `::warning::` naming the file, the attempt, the slice it ran and the
 *   failure, and the slice of the next; the last attempt's output follows. A staple after a repeat
 *   prints a `::notice::` naming the attempt and slice that worked. Each warning and notice also
 *   adds a line to the step summary, so a run that needed one shows it. If the arm64 slice cannot
 *   reach Apple either, the last attempt fails the step as before, after the budget: a leg that
 *   sits for twenty minutes holding the release is worse than a re-run.
 *
 * `EXECUTOR_STAPLE_WAITS` (comma-separated seconds) replaces the waits, for tests only.
 */
import { Config, Console, Effect, FileSystem, Path, Schema, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

export class StapleFailed extends Schema.TaggedError<StapleFailed>()("StapleFailed", {
  message: Schema.String,
}) {}

/** The waits before each repeat, in seconds. */
const defaultWaits = [10, 20, 40, 80, 160];

/** Whether the stapler's output says it could not reach Apple, and which failure it named. */
export const unreachable = (output: string): string | undefined => {
  const network = /NSURLErrorDomain Code=(-1001|-1004|-1005|-1009)\b/.exec(output);
  if (network !== null) return `NSURLErrorDomain ${network[1]}`;
  const status = /\b(?:Status Code|statusCode|status code)\s*[:=]\s*(5\d\d)\b/i.exec(output);
  if (status !== null) return `HTTP ${status[1]}`;
  return undefined;
};

/** One stapler run: its exit code and its output, stdout and stderr together. */
const run = (command: string, args: ReadonlyArray<string>, cwd: string) =>
  Effect.scoped(
    Effect.gen(function* () {
      const processes = yield* ChildProcessSpawner.ChildProcessSpawner;
      const child = yield* processes.spawn(ChildProcess.make(command, args, { cwd }));
      const [output, code] = yield* Effect.all(
        [child.all.pipe(Stream.decodeText(), Stream.mkString), child.exitCode],
        { concurrency: "unbounded" },
      );
      return { output, code: Number(code) };
    }),
  );

/** One `sysctl -n` value, or undefined where there is none, as on Linux. */
const sysctl = (key: string) =>
  run("sysctl", ["-n", key], ".").pipe(
    Effect.map(({ output, code }) => (code === 0 ? output.trim() : undefined)),
    Effect.orElseSucceed(() => undefined),
  );

export const staple = (file: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const waits = yield* Config.String("EXECUTOR_STAPLE_WAITS").pipe(
      Config.map((text) => text.split(",").map(Number)),
      Config.withDefault(defaultWaits),
    );
    const summary = yield* Config.String("GITHUB_STEP_SUMMARY").pipe(Config.option);
    const report = (kind: "warning" | "notice", line: string) =>
      Effect.gen(function* () {
        yield* Console.log(`::${kind} title=Stapling repeated::${line}`);
        if (summary._tag === "Some")
          yield* fs.writeFileString(summary.value, `- ${line}\n`, { flag: "a" });
      });
    const cwd = path.dirname(file);
    const name = path.basename(file);
    const stapler = ["stapler", "staple", "-v", name];
    const attempts = waits.length + 1;
    // The first attempt runs as before, in the calling process's slice: x86_64 under Rosetta on
    // the Intel leg. Repeats run the arm64 slice on Apple Silicon hardware.
    const translated = (yield* sysctl("sysctl.proc_translated")) === "1";
    const firstSlice = translated
      ? "x86_64 under Rosetta"
      : process.arch === "arm64"
        ? "arm64"
        : "x86_64";
    let slice = firstSlice;
    let last = yield* run("xcrun", stapler, cwd);
    let attempt = 1;
    for (const wait of waits) {
      if (last.code === 0) break;
      const cause = unreachable(last.output);
      if (cause === undefined) break;
      const arm64 = (yield* sysctl("hw.optional.arm64")) === "1";
      const next = arm64 ? "arm64" : firstSlice;
      // Every attempt's full stapler output, so a failed attempt's detail (the address it reached,
      // the underlying network error) can be compared with the next one's.
      yield* Console.log(
        `::group::Stapling ${name}: attempt ${attempt} of ${attempts} (${slice}) output\n${last.output.trimEnd()}\n::endgroup::`,
      );
      yield* report(
        "warning",
        `Stapling ${name}: attempt ${attempt} of ${attempts} (${slice}) could not reach Apple's ticket service (${cause}); attempt ${attempt + 1} in ${wait} s, with the ${next} slice.`,
      );
      yield* Effect.sleep(`${wait} seconds`);
      slice = next;
      attempt += 1;
      last = yield* arm64
        ? run("arch", ["-arm64", "xcrun", ...stapler], cwd)
        : run("xcrun", stapler, cwd);
    }
    yield* Console.log(last.output);
    if (last.code === 0) {
      if (attempt > 1)
        yield* report(
          "notice",
          `Stapling ${name}: attempt ${attempt} of ${attempts} (${slice}) stapled, after ${attempt - 1} that could not reach Apple's ticket service.`,
        );
      return;
    }
    const cause = unreachable(last.output);
    return yield* new StapleFailed({
      message:
        cause === undefined
          ? `Failed to staple ${name} with code: ${last.code}, on attempt ${attempt} (${slice})`
          : `Failed to staple ${name} with code: ${last.code}: attempt ${attempt} of ${attempts} (${slice}) still could not reach Apple's ticket service (${cause})`,
    });
  });
