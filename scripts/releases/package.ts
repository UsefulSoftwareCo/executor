/** Build a portable, platform-specific npm package. Nothing is published. */
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { Console, Effect, FileSystem, Path } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import { bundleLocalRuntime } from "./runtime-bundle.ts";
import {
  nativePlatform,
  npmArchiveBudgetBytes,
  platformArchive,
  platformVersion,
  release,
} from "./config.ts";
import { installWindowsGitHttpBackend } from "./windows-git.ts";

const build = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const processes = yield* ChildProcessSpawner.ChildProcessSpawner;
  const root = yield* path.fromFileUrl(new URL("../../", import.meta.url));
  const version = release.version;
  const target = nativePlatform(process.platform, process.arch);
  if (process.argv[2] !== undefined && process.argv[2] !== version)
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
    engines: { node: ">=24.14.0" },
    os: [process.platform],
    cpu: [process.arch],
    files: [
      "bin.mjs",
      "runtime-env.mjs",
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
  yield* fs.writeFileString(
    path.join(stage, "bin.mjs"),
    `#!/usr/bin/env node\nimport { homedir } from "node:os";\nimport { join } from "node:path";\nimport { packagedRuntimeEnvironment } from "./runtime-env.mjs";\nObject.assign(process.env, packagedRuntimeEnvironment(process.env));\nprocess.env.EXECUTOR_DATA_DIR ??= join(homedir(), ".executor", "v2", "cli");\nprocess.env.EXECUTOR_BUILD_VERSION = ${JSON.stringify(version)};\nawait import("./runtime/cli.mjs");\n`,
  );
  yield* fs.chmod(path.join(stage, "bin.mjs"), 0o755);
  yield* fs.copyFile(path.join(root, "scripts/releases/README.md"), path.join(stage, "README.md"));
  yield* fs.copyFile(path.join(root, "apps/cli/LICENSE"), path.join(stage, "LICENSE"));
  yield* installWindowsGitHttpBackend(stage);
  yield* run(
    "node",
    [
      "--input-type=module",
      "--eval",
      `import { spawnSync } from "node:child_process";
import { packagedRuntimeEnvironment } from "./runtime-env.mjs";
const result = spawnSync("git", ["--version"], {
  env: packagedRuntimeEnvironment({ ...process.env, PATH: "" }),
  stdio: "inherit",
});
if (result.error) throw result.error;
if (result.status !== 0) process.exit(1);
const backend = spawnSync("git", ["http-backend"], {
  env: packagedRuntimeEnvironment({ ...process.env, PATH: "", GIT_PROJECT_ROOT: process.cwd(),
    GIT_HTTP_EXPORT_ALL: "1", PATH_INFO: "/executor-release-probe-missing.git/info/refs",
    REQUEST_METHOD: "GET", QUERY_STRING: "service=git-upload-pack", SERVER_PROTOCOL: "HTTP/1.1" }),
  encoding: "utf8",
});
if (backend.error) throw backend.error;
if (backend.status !== 0 || !backend.stdout.includes("Status: 404")) {
  throw new Error("The bundled Git HTTP backend did not return the expected missing-repository response");
}`,
    ],
    stage,
  );
  // Windows npm is a shell wrapper. Invoke its JavaScript entry with Node, without a shell.
  const npm =
    process.platform === "win32"
      ? {
          command: process.execPath,
          prefix: [path.join(path.dirname(process.execPath), "node_modules/npm/bin/npm-cli.js")],
        }
      : { command: "npm", prefix: [] };
  yield* run(
    npm.command,
    [...npm.prefix, "pack", "--ignore-scripts", "--pack-destination", output],
    stage,
  );
  // Guard each native target before its offline tests or any publication can run.
  const bytes = Number((yield* fs.stat(path.join(output, platformArchive(target)))).size);
  const budgetBytes = npmArchiveBudgetBytes;
  yield* fs.writeFileString(
    path.join(output, "npm-size.json"),
    JSON.stringify({ bytes, budgetBytes }, null, 2),
  );
  if (bytes > budgetBytes)
    return yield* Effect.die(
      new Error(`npm archive exceeds the 180 MiB release budget: ${bytes} bytes`),
    );
  yield* Console.log(`Native artifact: ${output} (${(bytes / 1024 / 1024).toFixed(1)} MiB)`);
});
NodeRuntime.runMain(Effect.scoped(build).pipe(Effect.provide(NodeServices.layer)));
