import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { Console, Effect, FileSystem, Path, Schema } from "effect";
import { Hex } from "effect/encoding";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { desktopUpdateFeed, desktopUpdateFile, nativePlatform, release } from "./config.ts";
import { developerIdMac, unsignedMac } from "./macos-signing.ts";
import { installNodeRuntime } from "./node-runtime.ts";
import { smokePackagedCollector } from "./standalone.ts";
import macUsageDescriptions from "../../apps/local/desktop/assets/mac-usage-descriptions.json" with { type: "json" };
import {
  DesktopRuntimeBuild,
  desktopRuntimeBuildFile,
} from "../../apps/local/desktop/src/contracts/desktop.ts";

const developmentOnly = [
  "EXECUTOR_DESKTOP_DEV_UPDATE_CONFIG",
  "autoUpdater.forceDevUpdateConfig",
  "autoUpdater.updateConfigPath",
  "development-updates",
];

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
  const packaged = path.join(output, "package");
  if (!(yield* fs.exists(path.join(packaged, "bin.mjs"))))
    return yield* Effect.die(new Error("Build the matching CLI runtime before the desktop."));
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
  const notarize = process.argv.includes("--notarize");
  const signing = yield* notarize || process.argv.includes("--sign")
    ? developerIdMac({
        entitlements: path.join(root, "scripts/releases/entitlements.mac.plist"),
        notarize,
      })
    : Effect.succeed(unsignedMac);
  const updates = process.platform !== "darwin" || signing !== unsignedMac;
  if (yield* fs.exists(stage)) yield* fs.remove(stage, { recursive: true });
  if (yield* fs.exists(artifacts)) yield* fs.remove(artifacts, { recursive: true });
  yield* fs.makeDirectory(runtime, { recursive: true });
  yield* fs.copy(packaged, runtime, { overwrite: true });
  yield* installNodeRuntime(runtime);
  yield* fs.writeFileString(
    path.join(runtime, desktopRuntimeBuildFile),
    yield* Schema.encodeEffect(Schema.fromJsonString(DesktopRuntimeBuild))({
      version,
      build: Hex.encode(crypto.getRandomValues(new Uint8Array(6))),
    }),
  );
  yield* run("node", ["apps/local/desktop/scripts/build.mjs", "--release"], root);
  for (const entry of [
    "main.cjs",
    "starter.cjs",
    "preload-host.cjs",
    "preload-app.cjs",
    "preload-menu.cjs",
  ]) {
    yield* fs.copyFile(path.join(root, "apps/local/desktop/dist", entry), path.join(stage, entry));
    const bundled = yield* fs.readFileString(path.join(stage, entry));
    for (const development of developmentOnly)
      if (bundled.includes(development))
        return yield* Effect.die(new Error(`The release ${entry} contains ${development}`));
  }
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
    files: [
      "main.cjs",
      "starter.cjs",
      "preload-host.cjs",
      "preload-app.cjs",
      "preload-menu.cjs",
      "package.json",
    ],
    protocols: [{ name: "Executor apps", schemes: ["executor"] }],
    extraResources: [
      { from: runtime, to: "runtime" },
      { from: path.join(runtime, "node_modules"), to: "runtime/node_modules" },
      ...(process.platform === "darwin"
        ? [
            {
              from: path.join(root, "apps/local/desktop/dist/launcher-stub"),
              to: "launcher-stub",
            },
          ]
        : []),
    ],
    directories: { output: artifacts },
    artifactName: `${release.desktop.artifactPrefix}-` + "${version}-${os}-${arch}.${ext}",
    mac: {
      category: "public.app-category.developer-tools",
      target: ["dmg", "zip"],
      extendInfo: macUsageDescriptions,
      ...signing.mac,
    },
    dmg: { sign: signing.signDiskImages, writeUpdateInfo: false },
    win: { target: ["nsis"] },
    nsis: { include: path.join(root, "scripts/releases/desktop-uninstall.nsh") },
    linux: {
      executableName: release.desktop.executableName,
      category: "Development",
      target: ["AppImage", "deb"],
    },
    publish: updates
      ? {
          provider: "generic",
          url: desktopUpdateFeed.url,
          channel: desktopUpdateFeed.channel(release.channel),
        }
      : null,
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
  yield* smokePackagedCollector(root, target, artifacts);
  if (updates && !process.argv.includes("--dir")) {
    const metadata = path.join(artifacts, desktopUpdateFile(target, release.channel));
    if (!(yield* fs.exists(metadata)))
      return yield* Effect.die(new Error(`electron-builder did not write ${metadata}`));
  }
  yield* Console.log(`Desktop artifact (${signing.summary}): ${artifacts}`);
});
NodeRuntime.runMain(Effect.scoped(build).pipe(Effect.provide(NodeServices.layer)));
