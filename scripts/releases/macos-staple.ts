import { Config, Console, Effect, FileSystem, Path, Schema, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

export class StapleFailed extends Schema.TaggedError<StapleFailed>()("StapleFailed", {
  message: Schema.String,
}) {}

const defaultWaits = [10, 20, 40, 80, 160];

export const unreachable = (output: string): string | undefined => {
  const network = /NSURLErrorDomain Code=(-1001|-1004|-1005|-1009)\b/.exec(output);
  if (network !== null) return `NSURLErrorDomain ${network[1]}`;
  const status = /\b(?:Status Code|statusCode|status code)\s*[:=]\s*(5\d\d)\b/i.exec(output);
  if (status !== null) return `HTTP ${status[1]}`;
  return undefined;
};

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
