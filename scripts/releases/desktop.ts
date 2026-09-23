/** Package the verified CLI runtime beside Electron; sign only what the caller asked for. */
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { Console, Effect, FileSystem, Path, Schema } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import { emit } from "./emit.ts";
import { nativePlatform, platformArchive, release } from "./config.ts";
import { developerIdMac, unsignedMac } from "./macos-signing.ts";
import { installNodeRuntime } from "./node-runtime.ts";

const build = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const processes = yield* ChildProcessSpawner.ChildProcessSpawner;
  const root = yield* path.fromFileUrl(new URL("../../", import.meta.url));
  const version = release.version;
  const target = nativePlatform(process.platform, process.arch);
  const requestedVersion = process.argv.slice(2).find((argument) => !argument.startsWith("--"));
  if (requestedVersion !== undefined && requestedVersion !== version)
    return yield* Effect.die(new Error("Build the version recorded in apps/cli/package.json."));
  const output = path.join(
    root,
    ".local/releases",
    `${version}-${process.platform}-${process.arch}`,
  );
  const stage = path.join(output, "desktop");
  const artifacts = path.join(output, "desktop-artifacts");
  const runtime = path.join(stage, "runtime");
  const archive = path.join(output, platformArchive(target));
  if (!(yield* fs.exists(archive)))
    return yield* Effect.die(new Error("Build the matching CLI archive before the desktop."));
  const run = (
    command: string,
    args: readonly string[],
    cwd: string,
    env: Record<string, string> = {},
  ) =>
    processes
      .exitCode(
        ChildProcess.make(command, args, {
          cwd,
          env,
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
  // Signing is a deliberate choice per build, and notarizing implies signing.
  const notarize = process.argv.includes("--notarize");
  const signing = yield* notarize || process.argv.includes("--sign")
    ? developerIdMac({
        entitlements: path.join(root, "scripts/releases/entitlements.mac.plist"),
        notarize,
      })
    : Effect.succeed(unsignedMac);
  if (yield* fs.exists(stage)) yield* fs.remove(stage, { recursive: true });
  // Rebuilding one version must not retain older installers or pre-stapling maps.
  if (yield* fs.exists(artifacts)) yield* fs.remove(artifacts, { recursive: true });
  yield* fs.makeDirectory(runtime, { recursive: true });
  // Git Bash's GNU tar treats a Windows drive prefix in -f as a remote hostname.
  yield* run(
    "tar",
    ["-xzf", path.basename(archive), "--strip-components", "1", "-C", "desktop/runtime"],
    output,
  );
  yield* installNodeRuntime(runtime);
  yield* emit(
    path.join(root, "apps/local/desktop/src"),
    path.join(runtime, "apps/local/desktop/src"),
  );
  yield* fs.writeFileString(
    path.join(runtime, "desktop-server.mjs"),
    `import { packagedRuntimeEnvironment } from "./runtime-env.mjs";
Object.assign(process.env, packagedRuntimeEnvironment(process.env));
process.env.EXECUTOR_BUILD_VERSION = ${JSON.stringify(version)};
await import("./apps/local/desktop/src/server.js");
`,
  );
  yield* run("node", ["apps/local/desktop/scripts/build.mjs"], root);
  yield* fs.copyFile(
    path.join(root, "apps/local/desktop/dist/main.cjs"),
    path.join(stage, "main.cjs"),
  );
  yield* fs.writeFileString(
    path.join(stage, "package.json"),
    JSON.stringify({
      name: release.desktop.executableName,
      version,
      private: true,
      main: "main.cjs",
      description: "Executor desktop",
      homepage: release.cloudOrigin,
      author: { name: "Useful Software", email: "rhys@executor.sh" },
      license: "MIT",
    }),
  );
  const electron = yield* fs
    .readFileString(path.join(root, "apps/local/desktop/package.json"))
    .pipe(
      Effect.flatMap(
        Schema.decodeUnknownEffect(
          Schema.fromJsonString(
            Schema.Struct({ devDependencies: Schema.Struct({ electron: Schema.String }) }),
          ),
        ),
      ),
    );
  const config = {
    appId: release.desktop.appId,
    productName: release.desktop.productName,
    icon: path.join(root, "apps/local/desktop/assets/icon.png"),
    electronVersion: electron.devDependencies.electron,
    asar: true,
    npmRebuild: false,
    files: ["main.cjs", "package.json"],
    extraResources: [
      { from: runtime, to: "runtime" },
      // electron-builder deliberately omits a matcher's root node_modules.
      // Copy the already verified dependency tree through its own resource matcher.
      { from: path.join(runtime, "node_modules"), to: "runtime/node_modules" },
    ],
    directories: { output: artifacts },
    artifactName: `${release.desktop.artifactPrefix}-` + "${version}-${os}-${arch}.${ext}",
    mac: {
      category: "public.app-category.developer-tools",
      target: ["dmg", "zip"],
      ...signing.mac,
    },
    // DMGs are installers, not updater payloads. Stapling changes their bytes after this build.
    dmg: { sign: signing.signDiskImages, writeUpdateInfo: false },
    win: { target: ["nsis"] },
    linux: {
      executableName: release.desktop.executableName,
      category: "Development",
      target: ["AppImage", "deb"],
    },
    publish: null,
  };
  yield* fs.writeFileString(
    path.join(stage, "electron-builder.json"),
    JSON.stringify(config, null, 2),
  );
  yield* run(
    "bun",
    [
      "run",
      "--cwd",
      "apps/local/desktop",
      "electron-builder",
      "--projectDir",
      stage,
      "--config",
      path.join(stage, "electron-builder.json"),
      "--publish",
      "never",
      ...(process.argv.includes("--dir") ? ["--dir"] : []),
    ],
    root,
    signing.env,
  );
  yield* signing.finalize(artifacts);
  yield* Console.log(`Desktop artifact (${signing.summary}): ${artifacts}`);
});
NodeRuntime.runMain(Effect.scoped(build).pipe(Effect.provide(NodeServices.layer)));
