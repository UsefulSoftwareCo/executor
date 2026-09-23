/** Retention is host-owned blob storage; Node directories are disposable materializations. */
import * as Tar from "tar";
import { Effect, FileSystem, Option, Path, Schema, Stream } from "effect";
import * as NodeStream from "@effect/platform-node/NodeStream";
import { createGzip } from "node:zlib";
import { Readable } from "node:stream";
import { BlobKey, BlobStore } from "../contracts/blobs.ts";
import { BuiltApp, RuntimeBuildFailed, RuntimeBuildUnavailable } from "../contracts/runtime.ts";
import { BuildId } from "../contracts/shared.ts";

const localBuild = BuildId.check(Schema.makeFilter((id) => /^bld_[a-f0-9-]{36}$/.test(id)));
const key = (build: BuildId, file: string) =>
  Schema.decodeUnknownEffect(BlobKey)(`${build}/${file}`);
const unavailable = () => new RuntimeBuildUnavailable();
const manifestCodec = Schema.fromJsonString(BuiltApp);

/** Read the authoritative manifest before using any cached code or browser asset. */
export const nodeBuildManifest = (build: BuildId) =>
  Effect.gen(function* () {
    yield* Schema.decodeUnknownEffect(localBuild)(build);
    const blobs = yield* BlobStore;
    const found = yield* blobs.get(yield* key(build, "build.json"));
    if (Option.isNone(found)) return yield* unavailable();
    const manifest = yield* Schema.decodeUnknownEffect(manifestCodec)(
      new TextDecoder().decode(found.value),
    );
    if (manifest.build !== build) return yield* unavailable();
    return manifest;
  }).pipe(Effect.withSpan("runtime.node.manifest"), Effect.mapError(unavailable));

/** Archive with a maintained tar implementation, preserving executable bits and package symlinks. */
export const retainNodeBuild = (directory: string, manifest: BuiltApp) =>
  Effect.scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const blobs = yield* BlobStore;
      const temporary = yield* fs.makeTempDirectoryScoped({ prefix: "executor-archive-" });
      const file = path.join(temporary, "server.tgz");
      const names = (yield* fs.readDirectory(directory)).filter(
        (name) => name !== "server.tgz" && name !== ".executor-ready" && !name.startsWith(".blob-"),
      );
      // tar's built-in gzip runs synchronously on the server thread. Node's gzip
      // stream uses the worker pool; level 1 favors request latency over archive size.
      yield* NodeStream.fromReadable({
        evaluate: () =>
          Readable.from(Tar.create({ cwd: directory, portable: true, strict: true }, names), {
            objectMode: false,
            highWaterMark: 64 * 1024,
          }),
        // Batch small tar headers/files before crossing into the asynchronous codec.
        chunkSize: 64 * 1024,
        onError: () => new RuntimeBuildFailed({ stage: "retain" }),
      }).pipe(
        NodeStream.pipeThroughDuplex({
          evaluate: () => createGzip({ level: 1 }),
          onError: () => new RuntimeBuildFailed({ stage: "retain" }),
        }),
        Stream.run(fs.sink(file)),
        Effect.withSpan("runtime.node.archive"),
        Effect.uninterruptible,
      );
      yield* blobs.put(yield* key(manifest.build, "server.tgz"), yield* fs.readFile(file));
      yield* Effect.forEach(
        manifest.ui ?? [],
        (asset) =>
          Effect.gen(function* () {
            const assetKey = yield* key(manifest.build, `ui/${asset.path}`);
            yield* blobs.put(assetKey, yield* fs.readFile(path.join(directory, "ui", asset.path)));
          }),
        { concurrency: 8, discard: true },
      );
      // A deployment is publishable only after all server and browser bytes have been stored.
      yield* blobs.put(
        yield* key(manifest.build, "build.json"),
        new TextEncoder().encode(yield* Schema.encodeEffect(manifestCodec)(manifest)),
      );
    }),
  ).pipe(Effect.mapError(() => new RuntimeBuildFailed({ stage: "retain" })));

/** Restore into a staging directory and publish atomically. A lost cache needs no npm or rebuild. */
export const materializeNodeBuild = (workDirectory: string, build: BuildId) =>
  Effect.scoped(
    Effect.gen(function* () {
      yield* nodeBuildManifest(build);
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const blobs = yield* BlobStore;
      const root = path.resolve(workDirectory);
      const location = path.join(root, build);
      const ready = path.join(location, ".executor-ready");
      const cached = yield* fs.exists(ready);
      yield* Effect.annotateCurrentSpan("executor.build.cached", cached);
      if (cached) return location;
      const archive = yield* blobs.get(yield* key(build, "server.tgz"));
      if (Option.isNone(archive)) return yield* unavailable();
      yield* fs.makeDirectory(root, { recursive: true });
      const temporary = yield* fs.makeTempDirectoryScoped({
        directory: root,
        prefix: ".restoring-",
      });
      const file = path.join(temporary, "server.tgz");
      const staging = path.join(temporary, "build");
      yield* fs.makeDirectory(staging);
      yield* fs.writeFile(file, archive.value);
      yield* Effect.tryPromise(() =>
        Tar.extract({ cwd: staging, file, strict: true, preservePaths: false }),
      ).pipe(Effect.withSpan("runtime.node.extract"), Effect.uninterruptible);
      const manifest = yield* fs
        .readFileString(path.join(staging, "build.json"))
        .pipe(Effect.flatMap(Schema.decodeUnknownEffect(manifestCodec)));
      if (manifest.build !== build) return yield* unavailable();
      yield* fs.writeFileString(path.join(staging, ".executor-ready"), build);
      yield* fs.rename(staging, location).pipe(
        Effect.catch((error) =>
          Effect.gen(function* () {
            // Another request may have restored the same immutable build first.
            if (!(yield* fs.exists(ready))) return yield* error;
          }),
        ),
      );
      return location;
    }),
  ).pipe(Effect.withSpan("runtime.node.materialize"), Effect.mapError(unavailable));

/** Fetch individual browser objects without downloading the server's dependency archive. */
export const nodeBuildAsset = (build: BuildId, assetPath: string) =>
  Effect.gen(function* () {
    const manifest = yield* nodeBuildManifest(build);
    const asset = manifest.ui?.find((asset) => asset.path === assetPath);
    if (asset === undefined) return undefined;
    const blobs = yield* BlobStore;
    const found = yield* blobs.get(yield* key(build, `ui/${asset.path}`));
    if (Option.isNone(found)) return yield* unavailable();
    return { body: found.value, contentType: asset.contentType };
  }).pipe(Effect.mapError(unavailable));
