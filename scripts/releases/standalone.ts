import { Config, Console, Effect, FileSystem, Option, Path } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { releaseAnalytics } from "./analytics.ts";
import { type Platform, platformVersion, release } from "./config.ts";
import { signStandaloneMac } from "./macos-signing.ts";
import { treeDigest } from "./tree-digest.ts";
import { npmCommand } from "./npm.ts";
import { bundleStandaloneRuntime } from "./runtime-bundle.ts";

export const executableName = (target: Platform) =>
  target.platform === "win32" ? "executor.exe" : "executor";

const bunTarget = (target: Platform) =>
  `bun-${target.platform === "win32" ? "windows" : target.platform}-${target.arch}${target.platform === "darwin" && target.arch === "x64" ? "-baseline" : ""}`;

const bunRuntime = Effect.gen(function* () {
  const runtime = yield* Config.NonEmptyString("EXECUTOR_BUN_RUNTIME").pipe(Config.option);
  if (Option.isSome(runtime)) return runtime;
  const ci = yield* Config.String("CI").pipe(Config.option);
  if (Option.isSome(ci))
    return yield* Effect.die(
      new Error(
        "Set EXECUTOR_BUN_RUNTIME to the locked-down Bun runtime; see scripts/releases/bun-runtime/README.md.",
      ),
    );
  yield* Console.error(
    "Building on stock Bun, which honours BUN_OPTIONS and BUN_BE_BUN: a development build, never a release.",
  );
  return runtime;
});

export const smokePackagedCollector = (root: string, target: Platform, directory: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const processes = yield* ChildProcessSpawner.ChildProcessSpawner;
    const name = target.platform === "win32" ? "executor-collector.exe" : "executor-collector";
    const found: Array<string> = [];
    for (const file of yield* fs.readDirectory(directory, { recursive: true }))
      if (
        path.basename(file) === name &&
        (yield* fs.stat(path.join(directory, file))).type === "File"
      )
        found.push(path.join(directory, file));
    if (found.length === 0) return yield* Effect.die(new Error(`${directory} holds no ${name}`));
    for (const file of found)
      for (const step of [["smoke"]]) {
        const code = yield* processes.exitCode(
          ChildProcess.make(
            process.execPath,
            [
              path.join(root, "packages/telemetry/scripts/build-collector.ts"),
              "--target",
              `${target.platform}-${target.arch}`,
              "--executable",
              file,
              ...step,
            ],
            { cwd: root, stdout: "inherit", stderr: "inherit" },
          ),
        );
        if (code !== 0)
          return yield* Effect.die(
            new Error(`The packaged collector ${file} failed ${step.join(" ")} (exit ${code})`),
          );
      }
  });

export const payloadDigestFile = "payload.sha256";

const payloadDigest = (install: string) => treeDigest(install);

export const buildStandalone = (
  root: string,
  output: string,
  stage: string,
  target: Platform,
  signing: "unsigned" | "sign" | "notarize",
  submission?: string,
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const processes = yield* ChildProcessSpawner.ChildProcessSpawner;
    const run = (command: string, args: ReadonlyArray<string>, cwd: string) =>
      processes
        .exitCode(
          ChildProcess.make(command, args, {
            cwd,
            extendEnv: true,
            stdout: "inherit",
            stderr: "inherit",
          }),
        )
        .pipe(
          Effect.flatMap((code) =>
            code === 0 ? Effect.void : Effect.die(new Error(`${command} exited ${code}`)),
          ),
        );
    const install = path.join(output, "standalone");
    if (yield* fs.exists(install)) yield* fs.remove(install, { recursive: true });
    const modules = path.join(install, "runtime", "node_modules");
    yield* fs.makeDirectory(modules, { recursive: true });

    for (const directory of [
      path.join(stage, "node_modules"),
      path.join(stage, "runtime/node_modules"),
    ])
      for (const name of yield* fs.readDirectory(directory)) {
        if (name === "dugite") continue;
        yield* fs.copy(path.join(directory, name), path.join(modules, name));
      }
    yield* fs.copy(path.join(stage, "node_modules/dugite/git"), path.join(install, "runtime/git"));
    for (const resource of [
      "apps",
      "packages",
      "licenses",
      "runtime-packages.txt",
      "README.md",
      "LICENSE",
    ])
      yield* fs.copy(path.join(stage, resource), path.join(install, resource));

    const work = yield* fs.makeTempDirectoryScoped({ prefix: "executor-standalone-" });
    const bundle = path.join(output, "standalone-bundle.mjs");
    const metafile = yield* bundleStandaloneRuntime(root, bundle, {
      version: release.version,
      analytics: yield* releaseAnalytics,
    });
    yield* fs.writeFileString(path.join(output, "standalone-meta.json"), JSON.stringify(metafile));
    const executable = path.join(install, executableName(target));
    const runtime = yield* bunRuntime;
    yield* run(
      "bun",
      [
        "build",
        "--compile",
        Option.isSome(runtime)
          ? `--compile-executable-path=${runtime.value}`
          : `--target=${bunTarget(target)}`,
        "--no-compile-autoload-dotenv",
        "--no-compile-autoload-bunfig",
        "--no-compile-autoload-tsconfig",
        "--compile-autoload-package-json",
        ...(target.platform === "win32"
          ? [
              "--windows-title=Executor",
              "--windows-publisher=Useful Software",
              `--windows-version=${release.version.replace(/-.*$/u, "")}.0`,
              "--windows-description=Executor",
            ]
          : []),
        bundle,
        "--outfile",
        executable,
      ],
      root,
    );

    const version = yield* processes.string(
      ChildProcess.make(executable, ["--version"], {
        env:
          target.platform === "win32"
            ? {
                PATH: `${process.env.SystemRoot ?? "C:\\Windows"}\\System32`,
                SystemRoot: process.env.SystemRoot ?? "C:\\Windows",
                USERPROFILE: work,
              }
            : { PATH: "/usr/bin:/bin", HOME: work },
        extendEnv: false,
      }),
    );
    if (version.trim() !== `executor v${release.version}`)
      return yield* Effect.die(
        new Error(`The executable reported ${JSON.stringify(version.trim())}`),
      );
    yield* fs.writeFileString(path.join(output, payloadDigestFile), yield* payloadDigest(install));
    if (signing !== "unsigned")
      yield* signStandaloneMac(install, executable, {
        entitlements: path.join(root, "scripts/releases/entitlements.standalone.plist"),
        notarize: signing === "notarize",
        ...(submission === undefined ? {} : { submission }),
      });
    yield* smokePackagedCollector(root, target, install);

    yield* fs.writeFileString(
      path.join(install, "package.json"),
      JSON.stringify(
        {
          name: "executor",
          version: platformVersion(target),
          private: true,
          description: "Executor for one platform, started by the executor package",
          license: "MIT",
          homepage: release.cloudOrigin,
          repository: { type: "git", url: `https://github.com/${release.repository}.git` },
          os: [target.platform],
          cpu: [target.arch],
          files: [
            executableName(target),
            "runtime",
            "apps",
            "packages",
            "licenses",
            "runtime-packages.txt",
            "README.md",
            "LICENSE",
          ],
        },
        null,
        2,
      ),
    );
    const npm = yield* npmCommand;
    yield* run(
      npm.command,
      [...npm.prefix, "pack", "--ignore-scripts", "--pack-destination", output],
      install,
    );
    return install;
  });
