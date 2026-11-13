/** Resolve workflow inputs and platform paths from the release identity before building. */
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { Config, Effect, FileSystem } from "effect";
import {
  desktopAsset,
  desktopUpdateFeed,
  desktopUpdateFile,
  platformArchive,
  platforms,
  release,
} from "./config.ts";

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
    // A push to main runs the paced check every two hours or so: Linux x64 packaging and its
    // installed CLI suite, and the image on both architectures, at about USD 1 a run. macOS
    // runners cost 20 times as much as Linux x64 and Windows 8 to 16 times, so Linux arm64,
    // Windows and macOS packaging run in the publishing runs, which test every target before
    // they publish, and in manual build runs. CI's release lanes skip darwin too.
    const event = yield* Config.String("GITHUB_EVENT_NAME");
    const targets =
      event === "push"
        ? platforms.filter((target) => target.platform === "linux" && target.arch === "x64")
        : event === "pull_request"
          ? platforms.filter((target) => target.platform !== "darwin")
          : platforms;
    // Each job's matrix entry names the runner it runs on: `cli` overrides the platform's runner.
    const entry = (target: (typeof targets)[number]) => {
      const { cli, ...fields } = target;
      const directory = `.local/releases/${release.version}-${target.platform}-${target.arch}`;
      const unpacked =
        target.platform === "darwin"
          ? `${target.arch === "arm64" ? "mac-arm64" : "mac"}/${release.desktop.productName}.app/Contents/MacOS/${release.desktop.productName}`
          : target.platform === "win32"
            ? `win-unpacked/${release.desktop.productName}.exe`
            : `${target.arch === "arm64" ? "linux-arm64-unpacked" : "linux-unpacked"}/${release.desktop.executableName}`;
      return {
        ...fields,
        cliWorkers: cli === undefined ? 0 : cli.workers,
        directory,
        archive: `${directory}/${platformArchive(target)}`,
        desktop: `${directory}/desktop-artifacts/${unpacked}`,
        installer: `${directory}/desktop-artifacts/${desktopAsset(target)}`,
        update_info: `${directory}/desktop-artifacts/${desktopUpdateFile(target, release.channel)}`,
        ...(target.platform === "darwin"
          ? {
              update_archive: `${directory}/desktop-artifacts/${desktopAsset(target).replace(/\.dmg$/, ".zip")}`,
            }
          : {}),
      };
    };
    const matrix = targets.map(entry);
    const values = {
      publish: requested === "build" ? "false" : "true",
      version: release.version,
      channel: release.channel,
      tag: release.tag,
      repository: release.repository,
      image: release.image,
      desktop_package: release.desktop.executableName,
      desktop_update_feed: desktopUpdateFeed.tag,
      matrix: JSON.stringify({ include: matrix }),
      cli_matrix: JSON.stringify({
        include: targets.flatMap((target) =>
          target.cli === undefined ? [] : [{ ...entry(target), runner: target.cli.runner }],
        ),
      }),
      // The image builds and its scenarios run on each Linux platform's `local` runner size.
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
