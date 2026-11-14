/**
 * The `local` job packages the archive that is published. The jobs that test the CLI each package
 * the archive they test: every part of the installed CLI suite (`cli`), and the launcher, install
 * script and credential store checks (`checks`). Packaging is reproducible, so every archive a job
 * tested must be the bytes `local` publishes for its target.
 *
 * Except on macOS: every Developer ID signature carries its own secure timestamp, so two signed
 * archives of one commit differ in their signatures. There the jobs record the digest of what they
 * signed instead, which packaging writes beside the archive before signing (`payload.sha256`, see
 * scripts/releases/standalone.ts): the archive `local` publishes and the one `checks` tests must
 * hold the same files apart from their signatures.
 *
 * Usage:
 *   `node scripts/releases/archive-digests.ts record <archive> <file>` writes the archive's
 *   SHA-256 to `<file>`.
 *   `node scripts/releases/archive-digests.ts record-payload <archive> <file>` writes the digest
 *   of the archive's files before signing to `<file>`.
 *   `node scripts/releases/archive-digests.ts compare <directory>` reads the digest artifacts as
 *   actions/download-artifact lays them out, one directory per artifact, and the metadata job's
 *   matrices from RELEASE_MATRIX, CHECKS_MATRIX and CLI_MATRIX. Each release target needs one
 *   `local` digest and one `checks` digest, and each part of each `cli` job one more, every one a
 *   single SHA-256 equal to the target's `local` digest. Every target with a CLI suite needs a
 *   `cli` job building the same archive. Any other artifact fails the comparison.
 */
import { createHash } from "node:crypto";
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { Config, Console, Effect, FileSystem, Option, Path, Schema } from "effect";
import { treeFiles } from "./tree-digest.ts";

class ArchiveCheckFailed extends Schema.TaggedError<ArchiveCheckFailed>()("ArchiveCheckFailed", {
  message: Schema.String,
}) {}

const Target = Schema.Struct({
  platform: Schema.String,
  arch: Schema.String,
  archive: Schema.String,
  cliWorkers: Schema.Number,
  packagedTests: Schema.optional(Schema.Boolean),
  /** A `cli` job's part of the suite, `i/n`. */
  part: Schema.optional(Schema.String.check(Schema.isPattern(/^[1-9]\d*\/[1-9]\d*$/u))),
});
type Target = typeof Target.Type;
const Matrix = Schema.fromJsonString(Schema.Struct({ include: Schema.Array(Target) }));

const sha256 = /^[0-9a-f]{64}$/;
/**
 * Linux and Windows recovery parts build the unpacked desktop app themselves; macOS parts on a
 * build run test an unsigned app, and on a notarizing run the notarized app itself.
 */
const unpackedApp = (target: { readonly platform: string }) => target.platform !== "darwin";
const targetName = (target: Target) => `${target.platform}-${target.arch}`;
/** The digest artifact a job uploads for its target: `local`, `checks` or `cli-<part index>`. */
const side = (job: "local" | "checks" | "cli", target: Target) =>
  job === "cli" ? `cli-${target.part?.split("/")[0] ?? "1"}` : job;
const artifactName = (job: "local" | "checks" | "cli", target: Target) =>
  `archive-digest-${side(job, target)}-${targetName(target)}`;

const record = (archive: string, file: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const bytes = yield* fs.readFile(archive);
    yield* fs.makeDirectory(path.dirname(file), { recursive: true });
    yield* fs.writeFileString(file, createHash("sha256").update(bytes).digest("hex"));
  });

/** Copy the payload digest packaging wrote beside `archive` to `file`, after checking its form. */
/**
 * Files of an unpacked desktop app that differ between two builds of one commit and so are not
 * digested: the target-only files electron-builder writes into it for the .deb and AppImage, and
 * the runtime manifest's `build` field, which every build sets at random (scripts/releases/desktop.ts).
 */
const appContent = (relative: string, bytes: Uint8Array): Uint8Array | undefined => {
  if (relative === "resources/apparmor-profile" || relative === "resources/package-type")
    return undefined;
  if (relative !== "resources/runtime/desktop-runtime.json") return bytes;
  const { build: _, ...manifest } = JSON.parse(new TextDecoder().decode(bytes)) as Record<
    string,
    unknown
  >;
  return new TextEncoder().encode(JSON.stringify(manifest));
};

/**
 * Write the digest of the unpacked desktop app that holds `executable` (Linux and Windows), and,
 * when `files` is given, the per-file lines it hashes, so a mismatch can name the files.
 */
const recordApp = (executable: string, file: string, files?: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const lines = yield* treeFiles(path.dirname(executable), appContent);
    yield* fs.makeDirectory(path.dirname(file), { recursive: true });
    yield* fs.writeFileString(file, createHash("sha256").update(lines.join("\n")).digest("hex"));
    if (files !== undefined) {
      yield* fs.makeDirectory(path.dirname(files), { recursive: true });
      yield* fs.writeFileString(files, lines.join("\n"));
    }
  });

/** The paths whose bytes differ between two per-file lists, or that only one of them has. */
const differingFiles = (left: string, right: string) => {
  const parse = (text: string) =>
    new Map(
      text
        .split("\n")
        .filter((line) => line !== "")
        .map((line) => [
          line.slice(0, line.lastIndexOf(" ")),
          line.slice(line.lastIndexOf(" ") + 1),
        ]),
    );
  const a = parse(left);
  const b = parse(right);
  return [...new Set([...a.keys(), ...b.keys()])]
    .toSorted()
    .flatMap((file) =>
      a.get(file) === b.get(file)
        ? []
        : [
            a.has(file) && b.has(file)
              ? `${file}: different bytes`
              : `${file}: only in ${a.has(file) ? "local's app" : "the tested app"}`,
          ],
    );
};

const recordPayload = (archive: string, file: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const source = path.join(path.dirname(archive), "payload.sha256");
    const digest = yield* fs.readFileString(source);
    if (!sha256.test(digest))
      return yield* new ArchiveCheckFailed({
        message: `${source} is not exactly one SHA-256 digest.`,
      });
    yield* fs.makeDirectory(path.dirname(file), { recursive: true });
    yield* fs.writeFileString(file, digest);
  });

const matrix = (variable: string) =>
  Effect.gen(function* () {
    const text = yield* Config.String(variable);
    return yield* Schema.decodeUnknownEffect(Matrix)(text).pipe(
      Effect.mapError(
        () => new ArchiveCheckFailed({ message: `${variable} is not a release matrix.` }),
      ),
    );
  });

const duplicates = (variable: string, targets: ReadonlyArray<Target>) =>
  targets
    .map(
      (target) => `${targetName(target)}${target.part === undefined ? "" : ` part ${target.part}`}`,
    )
    .filter((name, index, names) => names.indexOf(name) !== index)
    .map((name) => `${variable} lists ${name} more than once.`);

const compare = (directory: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const release = (yield* matrix("RELEASE_MATRIX")).include;
    const checks = (yield* matrix("CHECKS_MATRIX")).include;
    const cli = (yield* matrix("CLI_MATRIX")).include;
    const recovery = (yield* matrix("RECOVERY_MATRIX")).include.filter(unpackedApp);
    const problems = [
      ...duplicates("RELEASE_MATRIX", release),
      ...duplicates("CHECKS_MATRIX", checks),
      ...duplicates("CLI_MATRIX", cli),
    ];
    const published = (job: Target) =>
      release.find((target) => targetName(target) === targetName(job));
    for (const target of release) {
      if (!checks.some((job) => targetName(job) === targetName(target)))
        problems.push(`${targetName(target)} has no checks job in CHECKS_MATRIX.`);
      if (target.cliWorkers > 0 && !cli.some((job) => targetName(job) === targetName(target)))
        problems.push(`${targetName(target)} runs the CLI suite but CLI_MATRIX has no job for it.`);
    }
    for (const [variable, jobs] of [
      ["CHECKS_MATRIX", checks],
      ["CLI_MATRIX", cli],
    ] as const)
      for (const job of jobs) {
        const target = published(job);
        if (target === undefined)
          problems.push(`${variable} tests ${targetName(job)}, which no release target builds.`);
        else if (job.archive !== target.archive)
          problems.push(
            `${variable}'s ${targetName(job)} job builds ${job.archive}, and local publishes ${target.archive}.`,
          );
      }
    for (const job of cli) {
      const target = published(job);
      if (target !== undefined && (target.cliWorkers === 0 || job.cliWorkers !== target.cliWorkers))
        problems.push(
          `CLI_MATRIX runs ${targetName(job)} with ${job.cliWorkers} workers, and its release target says ${target.cliWorkers}.`,
        );
    }
    if (cli.length === 0)
      problems.push("No release target runs the installed CLI suite, so no archive is tested.");

    const localArchive = (job: Target) => artifactName("local", job);
    const localApp = (job: Target) => `app-digest-local-${targetName(job)}`;
    const tested = [
      ...checks.map((job) => ({
        job,
        name: artifactName("checks", job),
        file: "checks.txt",
        reference: localArchive,
      })),
      ...cli.map((job) => ({
        job,
        name: artifactName("cli", job),
        file: "cli.txt",
        reference: localArchive,
      })),
      ...recovery.map((job) => ({
        job,
        name: `app-digest-recovery-${job.part?.split("/")[0] ?? "1"}-${targetName(job)}`,
        file: "recovery.txt",
        reference: localApp,
      })),
    ];
    const recorded = [
      ...release.map((job) => ({ job, name: localArchive(job), file: "local.txt" })),
      ...release
        .filter((job) => job.packagedTests === true && unpackedApp(job))
        .map((job) => ({ job, name: localApp(job), file: "local.txt" })),
      ...tested,
    ];
    const expected = new Set(recorded.map(({ name }) => name));
    const present = (yield* fs.exists(directory)) ? yield* fs.readDirectory(directory) : [];
    for (const name of present.toSorted())
      if (!expected.has(name)) problems.push(`Unexpected artifact ${name}.`);

    const digests = new Map<string, string>();
    for (const { job, name, file } of recorded) {
      const artifact = path.join(directory, name);
      if (!present.includes(name)) {
        problems.push(`Missing ${name}: no digest was recorded for ${targetName(job)}.`);
        continue;
      }
      if ((yield* fs.stat(artifact)).type !== "Directory") {
        problems.push(`${name} is not an artifact directory.`);
        continue;
      }
      const files = (yield* fs.readDirectory(artifact)).toSorted();
      if (files.length !== 1 || files[0] !== file) {
        problems.push(`${name} must hold only ${file}; it holds ${files.join(", ") || "nothing"}.`);
        continue;
      }
      const digest = yield* fs.readFileString(path.join(artifact, file));
      if (!sha256.test(digest)) {
        problems.push(`${name}/${file} is not exactly one SHA-256 digest.`);
        continue;
      }
      digests.set(name, digest);
    }

    for (const { job, name, reference } of tested) {
      const target = published(job);
      const local = target === undefined ? undefined : digests.get(reference(target));
      const digest = digests.get(name);
      if (local === undefined || digest === undefined) continue;
      yield* Console.log(`${name}: tested ${digest}, published ${local}`);
      if (digest !== local && !name.startsWith("app-"))
        problems.push(`${name}: the tested archive is not the published archive.`);
      if (digest !== local && name.startsWith("app-") && target !== undefined) {
        // Name the files that differ when both jobs uploaded their per-file lists.
        const lists = yield* Config.String("APP_FILES").pipe(Config.option);
        const read = (artifact: string) =>
          Option.isNone(lists)
            ? Effect.succeed(Option.none<string>())
            : fs.readFileString(path.join(lists.value, artifact, "files.txt")).pipe(Effect.option);
        const tested = yield* read(name.replace(/^app-digest-/u, "app-files-"));
        const packaged = yield* read(`app-files-local-${targetName(target)}`);
        const differences =
          Option.isSome(tested) && Option.isSome(packaged)
            ? differingFiles(packaged.value, tested.value)
            : [];
        problems.push(
          `${name}: the tested desktop app is not the app local packaged.${differences.length === 0 ? "" : `\n  ${differences.join("\n  ")}`}`,
        );
      }
    }
    if (problems.length > 0) return yield* new ArchiveCheckFailed({ message: problems.join("\n") });
    yield* Console.log("Every tested archive is the archive the release publishes.");
  });

NodeRuntime.runMain(
  Effect.gen(function* () {
    const [command, ...args] = process.argv.slice(2);
    if (command === "record" && args.length === 2) return yield* record(args[0]!, args[1]!);
    if (command === "record-app" && (args.length === 2 || args.length === 3))
      return yield* recordApp(args[0]!, args[1]!, args[2]);
    if (command === "record-payload" && args.length === 2)
      return yield* recordPayload(args[0]!, args[1]!);
    if (command === "compare" && args.length === 1) return yield* compare(args[0]!);
    return yield* new ArchiveCheckFailed({
      message:
        "Usage: archive-digests.ts record <archive> <file> | record-payload <archive> <file> | record-app <executable> <file> [<files>] | compare <directory>",
    });
  }).pipe(Effect.provide(NodeServices.layer)),
);
