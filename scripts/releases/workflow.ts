/** Resolve workflow inputs and platform paths from the release identity before building. */
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { Config, Effect, FileSystem } from "effect";
import { desktopAsset, platformArchive, platforms, release } from "./config.ts";

NodeRuntime.runMain(
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const output = yield* Config.String("GITHUB_OUTPUT");
    const requested = yield* Config.Literals(["build", "beta", "latest"], "RELEASE_CHANNEL");
    if (requested !== "build") {
      const ref = yield* Config.String("GITHUB_REF");
      if (ref !== "refs/heads/main" || requested !== release.channel)
        return yield* Effect.die(
          new Error("Publish from main and select the channel recorded in apps/cli/package.json."),
        );
    }
    const matrix = platforms.map((target) => {
      const directory = `.local/releases/${release.version}-${target.platform}-${target.arch}`;
      const unpacked =
        target.platform === "darwin"
          ? `${target.arch === "arm64" ? "mac-arm64" : "mac"}/${release.desktop.productName}.app/Contents/MacOS/${release.desktop.productName}`
          : target.platform === "win32"
            ? `win-unpacked/${release.desktop.productName}.exe`
            : `${target.arch === "arm64" ? "linux-arm64-unpacked" : "linux-unpacked"}/${release.desktop.executableName}`;
      return {
        ...target,
        directory,
        archive: `${directory}/${platformArchive(target)}`,
        desktop: `${directory}/desktop-artifacts/${unpacked}`,
        installer: `${directory}/desktop-artifacts/${desktopAsset(target)}`,
      };
    });
    const values = {
      publish: requested === "build" ? "false" : "true",
      version: release.version,
      channel: release.channel,
      tag: release.tag,
      repository: release.repository,
      image: release.image,
      desktop_package: release.desktop.executableName,
      matrix: JSON.stringify({ include: matrix }),
      docker_matrix: JSON.stringify({
        include: platforms
          .filter((target) => target.platform === "linux")
          .map((target) => ({
            runner: target.runner,
            arch: target.arch === "x64" ? "amd64" : "arm64",
          })),
      }),
    };
    yield* fs.writeFileString(
      output,
      Object.entries(values)
        .map(([key, value]) => `${key}=${value}\n`)
        .join(""),
      { flag: "a" },
    );
  }).pipe(Effect.provide(NodeServices.layer)),
);
