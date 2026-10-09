/**
 * The installed CLI suite runs in the `cli` job against an archive it packages itself, and the
 * `local` job packages the archive that is published. Packaging is reproducible, so each tested
 * target's two archives must be the same bytes.
 *
 * Usage:
 *   `node scripts/releases/archive-digests.ts record <archive> <file>` writes the archive's
 *   SHA-256 to `<file>`.
 *   `node scripts/releases/archive-digests.ts compare <directory>` reads the digest artifacts as
 *   actions/download-artifact lays them out, one directory per artifact, and the metadata job's
 *   matrices from RELEASE_MATRIX and CLI_MATRIX. Every release target with a CLI suite needs a
 *   `cli` job building the same archive path, and exactly one `local` and one `cli` digest, each
 *   one SHA-256, that are equal. Any other artifact fails the comparison.
 */
import { createHash } from "node:crypto";
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { Config, Console, Effect, FileSystem, Path, Schema } from "effect";

class ArchiveCheckFailed extends Schema.TaggedError<ArchiveCheckFailed>()("ArchiveCheckFailed", {
  message: Schema.String,
}) {}

const Target = Schema.Struct({
  platform: Schema.String,
  arch: Schema.String,
  archive: Schema.String,
  cliWorkers: Schema.Number,
});
type Target = typeof Target.Type;
const Matrix = Schema.fromJsonString(Schema.Struct({ include: Schema.Array(Target) }));

const sides = ["local", "cli"] as const;
const sha256 = /^[0-9a-f]{64}$/;
const targetName = (target: Target) => `${target.platform}-${target.arch}`;
const artifactName = (side: (typeof sides)[number], target: Target) =>
  `archive-digest-${side}-${targetName(target)}`;

const record = (archive: string, file: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const bytes = yield* fs.readFile(archive);
    yield* fs.makeDirectory(path.dirname(file), { recursive: true });
    yield* fs.writeFileString(file, createHash("sha256").update(bytes).digest("hex"));
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
    .map(targetName)
    .filter((name, index, names) => names.indexOf(name) !== index)
    .map((name) => `${variable} lists ${name} more than once.`);

const compare = (directory: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const release = (yield* matrix("RELEASE_MATRIX")).include;
    const cli = (yield* matrix("CLI_MATRIX")).include;
    const problems = [...duplicates("RELEASE_MATRIX", release), ...duplicates("CLI_MATRIX", cli)];
    const tested = release.filter((target) => target.cliWorkers > 0);
    if (tested.length === 0)
      problems.push("No release target runs the installed CLI suite, so no archive is tested.");
    for (const target of tested) {
      const job = cli.find((candidate) => targetName(candidate) === targetName(target));
      if (job === undefined)
        problems.push(`${targetName(target)} runs the CLI suite but CLI_MATRIX has no job for it.`);
      else if (job.archive !== target.archive || job.cliWorkers !== target.cliWorkers)
        problems.push(
          `${targetName(target)}'s cli job differs from its release target: it builds ${job.archive} with ${job.cliWorkers} workers, and local publishes ${target.archive} with ${target.cliWorkers}.`,
        );
    }
    for (const job of cli)
      if (!tested.some((target) => targetName(target) === targetName(job)))
        problems.push(
          `CLI_MATRIX tests ${targetName(job)}, which no release target with a CLI suite builds.`,
        );

    const expected = new Set(
      tested.flatMap((target) => sides.map((side) => artifactName(side, target))),
    );
    const present = (yield* fs.exists(directory)) ? yield* fs.readDirectory(directory) : [];
    for (const name of present.toSorted())
      if (!expected.has(name)) problems.push(`Unexpected artifact ${name}.`);

    const digests = new Map<string, string>();
    for (const target of tested)
      for (const side of sides) {
        const name = artifactName(side, target);
        const artifact = path.join(directory, name);
        if (!present.includes(name)) {
          problems.push(
            `Missing ${name}: the ${side} job recorded no digest for ${targetName(target)}.`,
          );
          continue;
        }
        if ((yield* fs.stat(artifact)).type !== "Directory") {
          problems.push(`${name} is not an artifact directory.`);
          continue;
        }
        const files = (yield* fs.readDirectory(artifact)).toSorted();
        if (files.length !== 1 || files[0] !== `${side}.txt`) {
          problems.push(
            `${name} must hold only ${side}.txt; it holds ${files.join(", ") || "nothing"}.`,
          );
          continue;
        }
        const digest = yield* fs.readFileString(path.join(artifact, `${side}.txt`));
        if (!sha256.test(digest)) {
          problems.push(`${name}/${side}.txt is not exactly one SHA-256 digest.`);
          continue;
        }
        digests.set(name, digest);
      }

    for (const target of tested) {
      const local = digests.get(artifactName("local", target));
      const suite = digests.get(artifactName("cli", target));
      if (local === undefined || suite === undefined) continue;
      yield* Console.log(`${targetName(target)}: tested ${suite}, published ${local}`);
      if (suite !== local)
        problems.push(`${targetName(target)}: the tested archive is not the published archive.`);
    }
    if (problems.length > 0) return yield* new ArchiveCheckFailed({ message: problems.join("\n") });
    yield* Console.log("Every tested archive is the archive the release publishes.");
  });

NodeRuntime.runMain(
  Effect.gen(function* () {
    const [command, ...args] = process.argv.slice(2);
    if (command === "record" && args.length === 2) return yield* record(args[0]!, args[1]!);
    if (command === "compare" && args.length === 1) return yield* compare(args[0]!);
    return yield* new ArchiveCheckFailed({
      message: "Usage: archive-digests.ts record <archive> <file> | compare <directory>",
    });
  }).pipe(Effect.provide(NodeServices.layer)),
);
