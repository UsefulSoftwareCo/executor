/**
 * The macOS staple repeat (scripts/releases/macos-staple.ts), run as the release job runs it, with a
 * stub `xcrun`, `arch` and `sysctl` first on PATH. Each `xcrun` call takes the next outcome from a
 * list: `net` loses the connection to Apple's ticket service, `5xx` gets a 503 from it, `other` fails
 * as a rejected or unsigned file would, and `ok` staples. The stub records each call and whether it
 * came through `arch -arm64`. The patched `@electron/notarize` 2.5.0, which electron-builder staples
 * the app with, is run from its installed copy the same way.
 */
import { expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { Effect, FileSystem, Path, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

const xcrun = `#!/bin/sh
n=$(cat "$STUB/count" 2>/dev/null || echo 0); n=$((n + 1)); echo "$n" > "$STUB/count"
outcome=$(sed -n "\${n}p" "$STUB/outcomes")
echo "call $n slice=\${STUB_SLICE:-caller} $*" >> "$STUB/calls"
case "$outcome" in
  ok) echo "The staple and validate action worked!"; exit 0 ;;
  net) echo 'error is Error Domain=NSURLErrorDomain Code=-1005 "The network connection was lost."'
       echo "CloudKit's response is inconsistent with expections: (null)"
       echo "The staple and validate action failed! Error 68."; exit 68 ;;
  5xx) echo "Response is <NSHTTPURLResponse> { Status Code: 503, Headers {} }"
       echo "The staple and validate action failed! Error 68."; exit 68 ;;
  *) echo "Could not validate ticket for the file: the signature is invalid."
     echo "The staple and validate action failed! Error 65."; exit 65 ;;
esac
`;
const arch = `#!/bin/sh
[ "$1" = -arm64 ] || { echo "stub arch: unexpected $*" >&2; exit 2; }
shift
STUB_SLICE=arm64 exec "$@"
`;
const sysctl = `#!/bin/sh
case "$2" in
  hw.optional.arm64) echo "$STUB_HARDWARE_ARM64" ;;
  sysctl.proc_translated) echo "$STUB_TRANSLATED" ;;
  *) exit 1 ;;
esac
`;

const setup = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const processes = yield* ChildProcessSpawner.ChildProcessSpawner;
  const root = yield* fs.makeTempDirectoryScoped({ prefix: "executor-staple-" });
  const bin = path.join(root, "bin");
  yield* fs.makeDirectory(bin);
  for (const [name, text] of [
    ["xcrun", xcrun],
    ["arch", arch],
    ["sysctl", sysctl],
  ] as const) {
    yield* fs.writeFileString(path.join(bin, name), text);
    yield* fs.chmod(path.join(bin, name), 0o755);
  }
  const app = path.join(root, "out", "Executor 2.app");
  yield* fs.makeDirectory(app, { recursive: true });

  /** Staple `app` with these outcomes, through `command`; the calls, output and summary. */
  const staple = (options: {
    readonly outcomes: ReadonlyArray<"ok" | "net" | "5xx" | "other">;
    readonly arm64?: boolean;
    readonly command?: ReadonlyArray<string>;
    readonly env?: Readonly<Record<string, string>>;
  }) =>
    Effect.scoped(
      Effect.gen(function* () {
        const stub = yield* fs.makeTempDirectoryScoped({ prefix: "executor-staple-stub-" });
        yield* fs.writeFileString(path.join(stub, "outcomes"), `${options.outcomes.join("\n")}\n`);
        const summary = path.join(stub, "summary.md");
        const [command, ...args] = options.command ?? ["node", "scripts/releases/staple.ts", app];
        const child = yield* processes.spawn(
          ChildProcess.make(command!, args, {
            env: {
              PATH: `${bin}:${process.env.PATH ?? ""}`,
              STUB: stub,
              STUB_HARDWARE_ARM64: options.arm64 === false ? "0" : "1",
              // The Intel leg's caller runs under Rosetta on Apple Silicon.
              STUB_TRANSLATED: options.arm64 === false ? "0" : "1",
              EXECUTOR_STAPLE_WAITS: "0,0,0,0,0",
              GITHUB_STEP_SUMMARY: summary,
              ...options.env,
            },
            extendEnv: true,
          }),
        );
        const [output, code] = yield* Effect.all(
          [child.all.pipe(Stream.decodeText(), Stream.mkString), child.exitCode],
          { concurrency: "unbounded" },
        );
        const read = (file: string) =>
          fs.exists(file).pipe(
            Effect.flatMap((exists) => (exists ? fs.readFileString(file) : Effect.succeed(""))),
            Effect.map((text) => text.split("\n").filter((line) => line !== "")),
          );
        return {
          code: Number(code),
          output,
          calls: yield* read(path.join(stub, "calls")),
          summary: yield* read(summary),
          warnings: output
            .split("\n")
            .filter((line) => line.startsWith("::warning") || line.startsWith("::notice")),
        };
      }),
    );
  return { path, root, app, staple };
});

const test = (name: string, body: Effect.Effect<void, unknown, never>) =>
  it.live(name, () => body, 60_000);
const run = <A, E>(
  effect: Effect.Effect<
    A,
    E,
    | FileSystem.FileSystem
    | Path.Path
    | ChildProcessSpawner.ChildProcessSpawner
    | import("effect").Scope.Scope
  >,
) => effect.pipe(Effect.scoped, Effect.provide(NodeServices.layer), Effect.asVoid);

test(
  "two losses of Apple's ticket service, then a staple: it passes, with a warning and a summary line for each repeat, each repeat on the arm64 slice",
  run(
    Effect.gen(function* () {
      const { staple } = yield* setup;
      const result = yield* staple({ outcomes: ["net", "net", "ok"] });
      expect(result.code, result.output).toBe(0);
      expect(result.calls).toEqual([
        "call 1 slice=caller stapler staple -v Executor 2.app",
        "call 2 slice=arm64 stapler staple -v Executor 2.app",
        "call 3 slice=arm64 stapler staple -v Executor 2.app",
      ]);
      expect(result.warnings).toEqual([
        "::warning title=Stapling repeated::Stapling Executor 2.app: attempt 1 of 6 (x86_64 under Rosetta) could not reach Apple's ticket service (NSURLErrorDomain -1005); attempt 2 in 0 s, with the arm64 slice.",
        "::warning title=Stapling repeated::Stapling Executor 2.app: attempt 2 of 6 (arm64) could not reach Apple's ticket service (NSURLErrorDomain -1005); attempt 3 in 0 s, with the arm64 slice.",
        "::notice title=Stapling repeated::Stapling Executor 2.app: attempt 3 of 6 (arm64) stapled, after 2 that could not reach Apple's ticket service.",
      ]);
      expect(result.summary).toHaveLength(3);
      // Each failed attempt's full output is in the log, in a group named by attempt and slice.
      expect(result.output).toContain(
        "::group::Stapling Executor 2.app: attempt 1 of 6 (x86_64 under Rosetta) output\n",
      );
      expect(result.output).toContain(
        "::group::Stapling Executor 2.app: attempt 2 of 6 (arm64) output\n",
      );
      expect(result.output.split('Code=-1005 "The network connection was lost."')).toHaveLength(3);
      expect(result.output.split("::endgroup::")).toHaveLength(3);
      expect(result.output).toContain("The staple and validate action worked!");
    }),
  ),
);

test(
  "a 5xx from the ticket service is repeated too; on Intel hardware the repeat runs the calling process's slice",
  run(
    Effect.gen(function* () {
      const { staple } = yield* setup;
      const result = yield* staple({ outcomes: ["5xx", "ok"], arm64: false });
      expect(result.code, result.output).toBe(0);
      expect(result.calls).toEqual([
        "call 1 slice=caller stapler staple -v Executor 2.app",
        "call 2 slice=caller stapler staple -v Executor 2.app",
      ]);
      expect(result.warnings).toEqual([
        "::warning title=Stapling repeated::Stapling Executor 2.app: attempt 1 of 6 (x86_64) could not reach Apple's ticket service (HTTP 503); attempt 2 in 0 s, with the x86_64 slice.",
        "::notice title=Stapling repeated::Stapling Executor 2.app: attempt 2 of 6 (x86_64) stapled, after 1 that could not reach Apple's ticket service.",
      ]);
    }),
  ),
);

test(
  "any other stapler failure fails at once, with no repeat and no warning",
  run(
    Effect.gen(function* () {
      const { staple } = yield* setup;
      const result = yield* staple({ outcomes: ["other", "ok"] });
      expect(result.code).not.toBe(0);
      expect(result.calls).toHaveLength(1);
      expect(result.warnings).toEqual([]);
      expect(result.summary).toEqual([]);
      expect(result.output).toContain(
        "Failed to staple Executor 2.app with code: 65, on attempt 1 (x86_64 under Rosetta)",
      );
      expect(result.output).not.toContain("still could not reach");
    }),
  ),
);

test(
  "losses for the whole budget fail after six attempts, with the last error",
  run(
    Effect.gen(function* () {
      const { staple } = yield* setup;
      const result = yield* staple({ outcomes: ["net", "net", "net", "net", "net", "net", "ok"] });
      expect(result.code).not.toBe(0);
      expect(result.calls).toHaveLength(6);
      expect(result.warnings).toHaveLength(5);
      expect(result.output).toContain('Code=-1005 "The network connection was lost."');
      expect(result.output).toContain(
        "Failed to staple Executor 2.app with code: 68: attempt 6 of 6 (arm64) still could not reach Apple's ticket service (NSURLErrorDomain -1005)",
      );
      expect(result.summary).toHaveLength(5);
    }),
  ),
);

test(
  "the patched @electron/notarize 2.5.0 staples the app through the repeat when the signing environment names it, and as before when it does not",
  run(
    Effect.gen(function* () {
      const { path, app, staple } = yield* setup;
      // The copy electron-builder (app-builder-lib 26.15.6) installs, pinned to the patched version.
      const staplejs = path.resolve(
        "node_modules/.bun/@electron+notarize@2.5.0/node_modules/@electron/notarize/lib/staple.js",
      );
      const caller = [
        "node",
        "-e",
        `require(${JSON.stringify(staplejs)}).stapleApp({ appPath: ${JSON.stringify(app)} }).then(() => console.log("stapled"), (error) => { console.log(String(error)); process.exit(1); })`,
      ];
      const through = yield* staple({
        outcomes: ["net", "ok"],
        command: caller,
        env: { EXECUTOR_STAPLE_SCRIPT: path.resolve("scripts/releases/staple.ts") },
      });
      expect(through.code, through.output).toBe(0);
      expect(through.calls).toHaveLength(2);
      expect(through.warnings).toHaveLength(2);
      expect(through.output).toContain("stapled");

      const unpatched = yield* staple({ outcomes: ["net", "ok"], command: caller });
      expect(unpatched.code).not.toBe(0);
      expect(unpatched.calls).toEqual(["call 1 slice=caller stapler staple -v Executor 2.app"]);
      expect(unpatched.output).toContain("Failed to staple your application with code: 68");
    }),
  ),
);

test(
  "the patched @electron/notarize rejects when the staple script fails, as it did when the stapler failed",
  run(
    Effect.gen(function* () {
      const { path, app, staple } = yield* setup;
      // The copy electron-builder (app-builder-lib 26.15.6) installs, pinned to the patched version.
      const staplejs = path.resolve(
        "node_modules/.bun/@electron+notarize@2.5.0/node_modules/@electron/notarize/lib/staple.js",
      );
      const caller = [
        "node",
        "-e",
        `require(${JSON.stringify(staplejs)}).stapleApp({ appPath: ${JSON.stringify(app)} }).then(() => console.log("stapled"), (error) => { console.log(String(error)); process.exit(1); })`,
      ];
      // A script that fails makes the patched stapleApp reject, as a failed stapler always did.
      const failing = yield* staple({
        outcomes: ["other", "ok"],
        command: caller,
        env: { EXECUTOR_STAPLE_SCRIPT: path.resolve("scripts/releases/staple.ts") },
      });
      expect(failing.code, failing.output).not.toBe(0);
      expect(failing.calls).toHaveLength(1);
      expect(failing.output).toContain("Failed to staple your application with code: 1");
      expect(failing.output).not.toContain("stapled");
    }),
  ),
);
