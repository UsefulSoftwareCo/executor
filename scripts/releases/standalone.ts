/**
 * Turn the packaged runtime into the release install: one `executor` executable that carries the
 * runtime's code, and beside it the files it runs or reads from disk. Those are workerd, Git, the
 * native bindings, PGlite, TypeScript, the dashboard and Motel. npm publishes this directory as the
 * platform package, and the same archive is the download the installers and Homebrew use.
 *
 * Layout, relative to the executable:
 * - `runtime/node_modules/`: packages loaded from disk (see `installedPackages`) and resources
 *   read through package resolution, such as the Executor app template.
 * - `runtime/git/`: the bundled Git.
 * - `apps/local/web/dist/client/`, `packages/telemetry/dist/motel/`: static resources.
 * - `licenses/`, `runtime-packages.txt`: notices for everything bundled or copied.
 */
import { Config, Console, Effect, FileSystem, Option, Path } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { releaseAnalytics } from "./analytics.ts";
import { type Platform, platformVersion, release } from "./config.ts";
import { signStandaloneMac } from "./macos-signing.ts";
import { npmCommand } from "./npm.ts";
import { bundleStandaloneRuntime } from "./runtime-bundle.ts";

/** The executable's file name on a platform. */
export const executableName = (target: Platform) =>
  target.platform === "win32" ? "executor.exe" : "executor";

/**
 * Stock Bun's runtime for a target, for development builds. Intel macOS uses the baseline build,
 * which needs no AVX2: it is the runtime the toolchain installs on the release runner, where it
 * runs under Rosetta.
 */
const bunTarget = (target: Platform) =>
  `bun-${target.platform === "win32" ? "windows" : target.platform}-${target.arch}${target.platform === "darwin" && target.arch === "x64" ? "-baseline" : ""}`;

/**
 * The Bun runtime the executable is built on. Stock Bun lets any local process run its own code
 * inside a compiled executable through environment variables such as BUN_OPTIONS, so a release
 * uses the locked-down runtime from bun-runtime/ (EXECUTOR_BUN_RUNTIME). CI and publishing
 * builds refuse to fall back to stock Bun.
 */
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

/**
 * Build the release install from `stage`, the packaged runtime, into `<output>/standalone`, and
 * pack it as the platform's npm archive in `output`. Returns the install directory.
 */
export const buildStandalone = (
  root: string,
  output: string,
  stage: string,
  target: Platform,
  signing: "unsigned" | "sign" | "notarize",
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

    // The code is compiled into the executable. Packages it loads from disk, and resources
    // found through package resolution, move under runtime/, where resolution from the
    // executable's runtime/cli.mjs finds them. dugite's JavaScript is bundled; only its Git stays.
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
    // Kept beside the release for diagnosis, as runtime-meta.json is; it is not published.
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
        // A compiled executable otherwise reads .env and bunfig.toml from the working directory.
        "--no-compile-autoload-dotenv",
        "--no-compile-autoload-bunfig",
        "--no-compile-autoload-tsconfig",
        // Packages loaded from runtime/node_modules resolve through their package.json.
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

    // The executable must start with no Node or Bun on PATH.
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
    if (signing !== "unsigned")
      yield* signStandaloneMac(install, executable, {
        entitlements: path.join(root, "scripts/releases/entitlements.standalone.plist"),
        notarize: signing === "notarize",
      });

    yield* fs.writeFileString(
      path.join(install, "package.json"),
      JSON.stringify(
        {
          name: "executor",
          version: platformVersion(target),
          description: "Executor for one platform, started by the executor package",
          license: "MIT",
          homepage: release.cloudOrigin,
          repository: { type: "git", url: `https://github.com/${release.repository}.git` },
          publishConfig: {
            access: "public",
            tag: `${release.channel}-${target.platform}-${target.arch}`,
          },
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
