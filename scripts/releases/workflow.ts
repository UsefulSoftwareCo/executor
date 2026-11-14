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

/** The job kinds a build run can be narrowed to (RELEASE_JOBS). */
const narrowableJobs = ["local", "checks", "cli", "recovery", "docker"] as const;

NodeRuntime.runMain(
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const output = yield* Config.String("GITHUB_OUTPUT");
    const requested = yield* Config.Literals(
      ["build", "check", "beta", "latest"],
      "RELEASE_CHANNEL",
    );
    // A build run may be narrowed to some targets and job kinds, to prove one job on one platform
    // without building and testing the rest. Checks and publications always run everything: a
    // check is main's record that the matrix is green, and a publication tests what it publishes.
    const list = (variable: string) =>
      Config.String(variable).pipe(
        Config.withDefault(""),
        Config.map((value) =>
          value
            .split(",")
            .map((entry) => entry.trim())
            .filter((entry) => entry !== ""),
        ),
      );
    const onlyTargets = yield* list("RELEASE_TARGETS");
    const onlyJobs = yield* list("RELEASE_JOBS");
    const narrowed = onlyTargets.length > 0 || onlyJobs.length > 0;
    if (narrowed && requested !== "build")
      return yield* Effect.die(
        new Error(
          `Only a build run can be narrowed to targets or jobs; a ${requested} run runs everything.`,
        ),
      );
    const targetNames = platforms.map((target) => `${target.platform}-${target.arch}`);
    const unknownTargets = onlyTargets.filter((name) => !targetNames.includes(name));
    const unknownJobs = onlyJobs.filter(
      (name) => !(narrowableJobs as ReadonlyArray<string>).includes(name),
    );
    if (unknownTargets.length + unknownJobs.length > 0)
      return yield* Effect.die(
        new Error(
          `Unknown ${[...unknownTargets, ...unknownJobs].join(", ")}. Targets: ${targetNames.join(", ")}. Jobs: ${narrowableJobs.join(", ")}.`,
        ),
      );
    if (requested !== "build" && requested !== "check") {
      const ref = yield* Config.String("GITHUB_REF");
      if (ref !== "refs/heads/main" || requested !== release.channel)
        return yield* Effect.die(
          new Error("Publish from main and select the channel recorded in apps/cli/package.json."),
        );
    }
    // A notarizing run signs the desktop app with the company's Developer ID, has Apple notarize
    // it, and leaves it downloadable as an artifact. Only main may ask for it. Only main's runs
    // sign the CLI as well: a build from another branch uses no release credentials.
    const notarizeRequested =
      (yield* Config.Literals(["true", "false"], "RELEASE_NOTARIZE").pipe(
        Config.withDefault("false"),
      )) === "true";
    if (notarizeRequested && narrowed)
      return yield* Effect.die(
        new Error(
          "A notarizing build tests the notarized app with every target: do not narrow it.",
        ),
      );
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
    const targets = (
      requested === "check"
        ? platforms.filter((target) => target.platform === "linux" && target.arch === "x64")
        : event === "pull_request"
          ? platforms.filter((target) => target.platform !== "darwin")
          : platforms
    ).filter(
      (target) =>
        onlyTargets.length === 0 || onlyTargets.includes(`${target.platform}-${target.arch}`),
    );
    /** Whether this run runs a job kind; a kind with no target left runs nothing either. */
    const runs = (job: (typeof narrowableJobs)[number]) =>
      onlyJobs.length === 0 || onlyJobs.includes(job);
    const ifRuns = <A>(job: (typeof narrowableJobs)[number], entries: ReadonlyArray<A>) =>
      runs(job) ? entries : [];
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
    const macosArm64 = (target: { readonly platform: string; readonly arch: string }) =>
      target.platform === "darwin" && target.arch === "arm64";
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
      // macOS arm64 builds, signs and notarizes the app the notarized recovery parts test, so it
      // is a job of its own (local-macos-arm64): those parts wait for it alone, whatever the
      // other targets' local legs are still doing.
      local_matrix: JSON.stringify({
        include: ifRuns(
          "local",
          matrix.filter((entry) => !macosArm64(entry)),
        ),
      }),
      local_macos_arm64_matrix: JSON.stringify({
        include: ifRuns("local", matrix.filter(macosArm64)),
      }),
      macos_arm64: ifRuns("local", matrix).some(macosArm64) ? "true" : "false",
      // Every part of the installed CLI suite runs on its own runner (e2e/run.ts --part).
      cli_matrix: JSON.stringify({
        include: ifRuns("cli", targets).flatMap((target) =>
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
      checks_matrix: JSON.stringify({ include: ifRuns("checks", matrix) }),
      // Each part of the desktop crash recovery scenarios (e2e/desktop-recovery.config.ts). A
      // run that notarizes tests the macOS app it notarizes, so its macOS parts wait for `local` and
      // run in `recovery-notarized`; every other part builds an unpacked app of its own.
      recovery_matrix: JSON.stringify({
        include: ifRuns(
          "recovery",
          recovery.filter((part) => !(notarizing && part.platform === "darwin")),
        ),
      }),
      notarized_recovery_matrix: JSON.stringify({
        include: recovery.filter((part) => notarizing && part.platform === "darwin"),
      }),
      // The image builds and its scenarios run on each Linux platform's `local` runner size.
      docker_matrix: JSON.stringify({
        include: ifRuns("docker", platforms)
          .filter((target) => target.platform === "linux")
          .filter(
            (target) =>
              onlyTargets.length === 0 || onlyTargets.includes(`${target.platform}-${target.arch}`),
          )
          .map((target) => ({
            runner: target.runner,
            arch: target.arch === "x64" ? "amd64" : "arm64",
          })),
      }),
    };
    // Each kind runs when its matrix has an entry: GitHub refuses an empty matrix, so its job is
    // skipped instead, and the releases job expects exactly these.
    const included = (key: keyof typeof values) =>
      (JSON.parse(values[key]) as { include: ReadonlyArray<unknown> }).include.length > 0
        ? "true"
        : "false";
    const kinds = {
      narrowed: narrowed ? "true" : "false",
      run_local: included("local_matrix"),
      run_checks: included("checks_matrix"),
      run_cli: included("cli_matrix"),
      run_recovery: included("recovery_matrix"),
      run_docker: included("docker_matrix"),
    };
    // A narrowed run must still run something, and a whole-matrix run, a check or a publication
    // must run every kind: one left empty would pass untested.
    const empty = Object.entries(kinds)
      .filter(([key, value]) => key.startsWith("run_") && value !== "true")
      .map(([key]) => key.slice("run_".length));
    if (narrowed && empty.length === Object.keys(kinds).length - 1)
      return yield* Effect.die(
        new Error(
          `This selection is empty: no ${onlyJobs.join(", ") || "job"} runs on ${onlyTargets.join(", ") || "any target"}. Name a job the targets have.`,
        ),
      );
    if (!narrowed && empty.length > 0)
      return yield* Effect.die(
        new Error(
          `A ${requested} run must run every job kind, but no target has ${empty.join(", ")}. Check scripts/releases/config.ts.`,
        ),
      );
    yield* fs.writeFileString(
      output,
      Object.entries({ ...values, ...kinds })
        .map(([key, value]) => `${key}=${value}\n`)
        .join(""),
      { flag: "a" },
    );
  }).pipe(Effect.provide(NodeServices.layer)),
);
