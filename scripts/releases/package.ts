/** Build the platform's release install and its npm package. Nothing is published. */
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { Config, Console, Effect, FileSystem, Path, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { bundleLocalRuntime } from "./runtime-bundle.ts";
import { nativePlatform, platformArchive, platformVersion, release } from "./config.ts";
import { installWindowsGitHttpBackend } from "./windows-git.ts";
import { launcherAnalytics } from "./analytics.ts";
import { buildStandalone } from "./standalone.ts";
import { bundledGit } from "../../packages/app-source/src/node.ts";

const build = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const processes = yield* ChildProcessSpawner.ChildProcessSpawner;
  const root = yield* path.fromFileUrl(new URL("../../", import.meta.url));
  const version = release.version;
  const target = nativePlatform(process.platform, process.arch);
  const requested = process.argv.slice(2).find((argument) => !argument.startsWith("--"));
  if (requested !== undefined && requested !== version)
    return yield* Effect.die(new Error("Build the version recorded in apps/cli/package.json."));
  const output = path.join(
    root,
    ".local/releases",
    `${version}-${process.platform}-${process.arch}`,
  );
  const stage = path.join(output, "package");
  const run = (command: string, args: readonly string[], cwd: string) =>
    processes
      .exitCode(
        ChildProcess.make(command, args, {
          cwd,
          env: { EXECUTOR_BUILD_VERSION: version },
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
  yield* run("bun", ["run", "apps:build"], root);
  yield* run("bun", ["run", "telemetry:build"], root);
  yield* run("bun", ["run", "web:build"], root);
  yield* fs.makeDirectory(output, { recursive: true });
  if (yield* fs.exists(stage)) yield* fs.remove(stage, { recursive: true });
  yield* fs.makeDirectory(stage);

  const dependencies = yield* bundleLocalRuntime(root, stage);
  yield* fs.copyFile(
    path.join(root, "scripts/releases/runtime-env.mjs"),
    path.join(stage, "runtime-env.mjs"),
  );
  yield* fs.copyFile(
    path.join(root, "scripts/releases/compile-cache.mjs"),
    path.join(stage, "compile-cache.mjs"),
  );
  yield* fs.copy(path.join(root, "scripts/releases/licenses"), path.join(stage, "licenses"), {
    overwrite: true,
  });
  const manifest = {
    name: "executor",
    version: platformVersion(target),
    private: false,
    type: "module",
    description: "Executor native runtime",
    license: "MIT",
    repository: { type: "git", url: `https://github.com/${release.repository}.git` },
    publishConfig: {
      access: "public",
      tag: `${release.channel}-${target.platform}-${target.arch}`,
    },
    os: [process.platform],
    cpu: [process.arch],
    files: [
      "bin.mjs",
      "runtime-env.mjs",
      "compile-cache.mjs",
      "apps",
      "packages",
      "licenses",
      "runtime",
      "alchemy-workers",
      "runtime-packages.txt",
      "README.md",
      "LICENSE",
    ],
    dependencies,
    bundledDependencies: Object.keys(dependencies),
    imports: { "#cloudflare-runtime-core-worker/*": "./alchemy-workers/*.mjs" },
  };
  yield* fs.writeFileString(path.join(stage, "package.json"), JSON.stringify(manifest, null, 2));
  // Node's compile cache keeps the runtime's compiled code in the user's cache directory, so every
  // launch after the first skips recompiling the bundled server (about 150 ms).
  yield* fs.writeFileString(
    path.join(stage, "bin.mjs"),
    `#!/usr/bin/env node\nimport { flushCompileCache } from "node:module";\nimport { homedir } from "node:os";\nimport { join } from "node:path";\nimport { enablePrivateCompileCache } from "./compile-cache.mjs";\nimport { useBundledGit } from "./runtime-env.mjs";\nuseBundledGit();\nprocess.env.EXECUTOR_DATA_DIR ??= join(homedir(), ".executor", "v2", "cli");\nprocess.env.EXECUTOR_BUILD_VERSION = ${JSON.stringify(version)};\n${yield* launcherAnalytics}enablePrivateCompileCache();\nawait import("./runtime/cli.mjs");\nflushCompileCache();\n`,
  );
  yield* fs.chmod(path.join(stage, "bin.mjs"), 0o755);
  yield* fs.copyFile(path.join(root, "scripts/releases/README.md"), path.join(stage, "README.md"));
  yield* fs.copyFile(path.join(root, "apps/cli/LICENSE"), path.join(stage, "LICENSE"));
  yield* installWindowsGitHttpBackend(stage);
  // The bundled Git runs with no other Git on PATH and answers Git's HTTP protocol.
  const git = bundledGit(path.join(stage, "node_modules/dugite/git"));
  const inherited = Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] =>
        entry[1] !== undefined && entry[0].toUpperCase() !== "PATH",
    ),
  );
  const probe = (args: readonly string[], environment: Record<string, string> = {}) =>
    Effect.scoped(
      Effect.gen(function* () {
        const child = yield* processes.spawn(
          ChildProcess.make(git.executable, args, {
            cwd: stage,
            extendEnv: false,
            env: { ...inherited, PATH: "", ...git.environment, ...environment },
            stdin: "ignore",
            stdout: "pipe",
            stderr: "inherit",
          }),
        );
        const [code, stdout] = yield* Effect.all(
          [child.exitCode, child.stdout.pipe(Stream.decodeText(), Stream.mkString)],
          { concurrency: 2 },
        );
        return { code: Number(code), stdout };
      }),
    );
  const started = yield* probe(["--version"]);
  if (started.code !== 0 || !started.stdout.startsWith("git version "))
    return yield* Effect.die(new Error(`The bundled Git did not start: ${started.stdout}`));
  yield* Console.log(started.stdout.trim());
  const backend = yield* probe(["http-backend"], {
    GIT_PROJECT_ROOT: stage,
    GIT_HTTP_EXPORT_ALL: "1",
    PATH_INFO: "/executor-release-probe-missing.git/info/refs",
    REQUEST_METHOD: "GET",
    QUERY_STRING: "service=git-upload-pack",
    SERVER_PROTOCOL: "HTTP/1.1",
  });
  if (backend.code !== 0 || !backend.stdout.includes("Status: 404"))
    return yield* Effect.die(
      new Error(
        "The bundled Git HTTP backend did not return the expected missing-repository response",
      ),
    );
  // The npm package is the release install: the executable and the files beside it. The staged
  // runtime stays for the desktop app, which runs it with its own Node.
  // Signing is a deliberate choice per build, and notarizing implies signing. A published macOS
  // build must be notarized.
  const notarize = process.argv.includes("--notarize");
  const signing = notarize ? "notarize" : process.argv.includes("--sign") ? "sign" : "unsigned";
  if (
    target.platform === "darwin" &&
    signing !== "notarize" &&
    (yield* Config.String("EXECUTOR_RELEASE_PUBLISH").pipe(Config.withDefault(""))) === "true"
  )
    return yield* Effect.die(new Error("A published macOS build must be signed and notarized."));
  // `--submission=<file>`: notarize without waiting; `macos-notarization.ts <file>` waits.
  const submission = process.argv
    .find((argument) => argument.startsWith("--submission="))
    ?.slice("--submission=".length);
  if (submission !== undefined && (submission === "" || signing !== "notarize"))
    return yield* Effect.die(new Error("--submission=<file> needs a file and --notarize."));
  yield* buildStandalone(root, output, stage, target, signing, submission);
  const bytes = Number((yield* fs.stat(path.join(output, platformArchive(target)))).size);
  yield* Console.log(`Native artifact: ${output} (${(bytes / 1024 / 1024).toFixed(1)} MiB)`);
});
NodeRuntime.runMain(Effect.scoped(build).pipe(Effect.provide(NodeServices.layer)));
