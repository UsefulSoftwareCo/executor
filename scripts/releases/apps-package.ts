/**
 * Pack and compare staged `apps` packages exactly as npm publishes them. npm packs `package.json`
 * unchanged and publishes the packed archive, so no file is exempt. Comparing unpacked files keeps
 * the comparison independent of the npm version's tar and gzip output.
 */
import { createHash } from "node:crypto";
import { Effect, FileSystem, Path, Schema } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

export const staged = "packages/apps/dist";

const Packed = Schema.NonEmptyArray(Schema.Struct({ filename: Schema.String }));
const Manifest = Schema.Struct({ version: Schema.String });

export class AppsReleaseMismatch extends Schema.TaggedError<AppsReleaseMismatch>()(
  "AppsReleaseMismatch",
  { message: Schema.String },
) {}

export const integrityOf = (bytes: Uint8Array) =>
  `sha512-${createHash("sha512").update(bytes).digest("base64")}`;

/** The version of a staged package, failing when it has not been built. */
export const stagedVersion = (directory: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    return yield* fs.readFileString(path.join(directory, "package.json")).pipe(
      Effect.flatMap(Schema.decodeUnknownEffect(Schema.fromJsonString(Manifest))),
      Effect.map((manifest) => manifest.version),
      Effect.mapError(
        () =>
          new AppsReleaseMismatch({
            message: `${directory} is missing; run bun run apps:build first.`,
          }),
      ),
    );
  });

/** Pack a staged package into an empty `destination` without running scripts. */
export const pack = (directory: string, destination: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const processes = yield* ChildProcessSpawner.ChildProcessSpawner;
    yield* fs.makeDirectory(destination, { recursive: true });
    const packed = yield* processes
      .string(
        ChildProcess.make(
          "npm",
          ["pack", directory, "--json", "--ignore-scripts", "--pack-destination", destination],
          { stdout: "pipe", stderr: "ignore" },
        ),
      )
      .pipe(Effect.flatMap(Schema.decodeUnknownEffect(Schema.fromJsonString(Packed))));
    const archive = path.join(destination, packed[0].filename);
    return { archive, integrity: integrityOf(yield* fs.readFile(archive)) };
  });

/** Unpack an npm archive into a new `target` directory. */
export const unpack = (archive: string, target: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const processes = yield* ChildProcessSpawner.ChildProcessSpawner;
    yield* fs.makeDirectory(target, { recursive: true });
    yield* processes.string(ChildProcess.make("tar", ["-xzf", archive, "-C", target]));
    return target;
  });

/** Every file present in only one of two unpacked packages or differing in bytes, sorted. */
export const differingFiles = (left: string, right: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const files = (root: string) =>
      fs.readDirectory(root, { recursive: true }).pipe(
        Effect.flatMap((entries) =>
          Effect.filter(entries, (entry) =>
            fs.stat(path.join(root, entry)).pipe(Effect.map((info) => info.type === "File")),
          ),
        ),
        Effect.map((entries) => new Set(entries)),
      );
    const ours = yield* files(left);
    const theirs = yield* files(right);
    const differing: string[] = [];
    for (const file of [...new Set([...ours, ...theirs])].toSorted()) {
      if (!ours.has(file) || !theirs.has(file)) {
        differing.push(file);
        continue;
      }
      const [a, b] = yield* Effect.all([
        fs.readFile(path.join(left, file)),
        fs.readFile(path.join(right, file)),
      ]);
      if (Buffer.compare(a, b) !== 0) differing.push(file);
    }
    return differing;
  });

export const listFiles = (files: readonly string[]) =>
  `Differing files (${files.length}): ${files.slice(0, 20).join(", ")}${files.length > 20 ? ", ..." : ""}`;
