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
  recoveryParts,
} from "./config.ts";

NodeRuntime.runMain(
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const output = yield* Config.String("GITHUB_OUTPUT");
    const requested = yield* Config.Literals(
      ["build", "check", "beta", "latest"],
      "RELEASE_CHANNEL",
    );
    if (requested !== "build" && requested !== "check") {
      const ref = yield* Config.String("GITHUB_REF");
      if (ref !== "refs/heads/main" || requested !== release.channel)
        return yield* Effect.die(
          new Error("Publish from main and select the channel recorded in apps/cli/package.json."),
        );
    }
    // A notarizing run signs the desktop app with the company's Developer ID, has Apple notarize
    // it, and leaves it downloadable as an artifact. Only publishing runs did that before, and only
    // from main, so only main may ask for it. (Any branch's run signs the CLI with Developer ID, as
    // before; that is the release environment's to restrict.)
    const notarizeRequested =
      (yield* Config.Literals(["true", "false"], "RELEASE_NOTARIZE").pipe(
        Config.withDefault("false"),
      )) === "true";
    if (notarizeRequested && (yield* Config.String("GITHUB_REF")) !== "refs/heads/main")
      return yield* Effect.die(
        new Error("Notarize from main: it signs and notarizes the desktop app."),
      );
    // The paced check on main, which runs every two hours or so when a push changed what a
    // release lane builds or runs: Linux x64 packaging and its installed CLI suite, and the image
    // on both architectures, at about USD 1 a run. macOS
    // runners cost 20 times as much as Linux x64 and Windows 8 to 16 times, so Linux arm64,
    // Windows and macOS packaging run in the publishing runs, which test every target before
    // they publish, and in manual build runs. CI's release lanes skip darwin too.
    const event = yield* Config.String("GITHUB_EVENT_NAME");
    const targets =
      requested === "check"
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
    const intel = (target: { readonly platform: string; readonly arch: string }) =>
      target.platform === "darwin" && target.arch === "x64";
    const publishing = requested !== "build" && requested !== "check";
    // A build run asked to notarize signs, notarizes and tests the macOS apps as a publishing run
    // does, and publishes nothing.
    const notarizing = publishing || (requested === "build" && notarizeRequested);
    const recovery = targets.flatMap((target) =>
      target.packagedTests
        ? Array.from({ length: recoveryParts }, (_, index) => ({
            ...entry(target),
            part: `${index + 1}/${recoveryParts}`,
            partIndex: index + 1,
          }))
        : [],
    );
    const values = {
      publish: publishing ? "true" : "false",
      notarize: notarizing ? "true" : "false",
      version: release.version,
      channel: release.channel,
      tag: release.tag,
      repository: release.repository,
      image: release.image,
      desktop_package: release.desktop.executableName,
      desktop_update_feed: desktopUpdateFeed.tag,
      matrix: JSON.stringify({ include: matrix }),
      // Intel macOS packages under Rosetta and takes about four minutes longer than any other
      // target, so it is a job of its own (local-intel): the jobs that need local, such as the
      // notarized arm64 recovery parts, do not wait for it.
      local_matrix: JSON.stringify({ include: matrix.filter((entry) => !intel(entry)) }),
      local_intel_matrix: JSON.stringify({ include: matrix.filter(intel) }),
      intel: matrix.some(intel) ? "true" : "false",
      // Every part of the installed CLI suite runs on its own runner (e2e/run.ts --part).
      cli_matrix: JSON.stringify({
        include: targets.flatMap((target) =>
          target.cli === undefined
            ? []
            : Array.from({ length: target.cli.parts }, (_, index) => ({
                ...entry(target),
                runner: target.cli.runner,
                part: `${index + 1}/${target.cli.parts}`,
                partIndex: index + 1,
              })),
        ),
      }),
      // The launcher, install script and credential store checks, beside the packaging in `local`.
      checks_matrix: JSON.stringify({ include: matrix }),
      // Each part of the desktop crash recovery scenarios (e2e/desktop-recovery.config.ts). A
      // run that notarizes tests the macOS app it notarizes, so its macOS parts wait for `local` and
      // run in `recovery-notarized`; every other part builds an unpacked app of its own.
      recovery_matrix: JSON.stringify({
        include: recovery.filter((part) => !(notarizing && part.platform === "darwin")),
      }),
      notarized_recovery_matrix: JSON.stringify({
        include: recovery.filter((part) => notarizing && part.platform === "darwin"),
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
