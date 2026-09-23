/** Atomic filesystem objects through Effect platform services. */
import { Effect, FileSystem, Option, Path, Predicate, Schema } from "effect";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { BlobKey, BlobStoreError, type BlobStorage } from "../contracts/blobs.ts";

/** Keep objects under a caller-owned directory. Symlinks may not escape that root. Construction performs no I/O. */
export const filesystemBlobStore = (options: { readonly directory: string }): BlobStorage => {
  const location = (key: BlobKey, write: boolean) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      yield* Schema.decodeUnknownEffect(BlobKey)(key);
      const root = path.resolve(options.directory);
      if (write) yield* fs.makeDirectory(root, { recursive: true });
      if (!(yield* fs.exists(root))) return undefined;
      const realRoot = yield* fs.realPath(root);
      const target = path.resolve(root, key);
      if (!target.startsWith(root + path.sep))
        return yield* Effect.fail(new BlobStoreError({ operation: write ? "put" : "get" }));
      // Verify existing ancestors before creating any directories through a symlink.
      let parent = path.dirname(target);
      while (!(yield* fs.exists(parent))) parent = path.dirname(parent);
      const actualParent = yield* fs.realPath(parent);
      if (actualParent !== realRoot && !actualParent.startsWith(realRoot + path.sep))
        return yield* Effect.fail(new BlobStoreError({ operation: write ? "put" : "get" }));
      if (yield* fs.exists(target)) {
        const actual = yield* fs.realPath(target);
        if (!actual.startsWith(realRoot + path.sep))
          return yield* Effect.fail(new BlobStoreError({ operation: write ? "put" : "get" }));
      }
      return { fs, path, target };
    });
  return {
    get: (key) =>
      Effect.gen(function* () {
        const found = yield* location(key, false);
        if (found === undefined) return Option.none();
        return yield* found.fs.readFile(found.target).pipe(
          Effect.map(Option.some),
          Effect.catchIf(
            (error) => Predicate.isTagged(error.reason, "NotFound"),
            () => Effect.succeed(Option.none()),
          ),
        );
      }).pipe(
        Effect.mapError(() => new BlobStoreError({ operation: "get" })),
        Effect.provide(NodeServices.layer),
      ),
    put: (key, body) =>
      Effect.scoped(
        Effect.gen(function* () {
          const found = yield* location(key, true);
          if (found === undefined) return yield* new BlobStoreError({ operation: "put" });
          const { fs, path, target } = found;
          const parent = path.dirname(target);
          yield* fs.makeDirectory(parent, { recursive: true });
          const staging = yield* fs.makeTempDirectoryScoped({
            directory: parent,
            prefix: ".blob-",
          });
          const file = path.join(staging, "body");
          yield* fs.writeFile(file, body);
          yield* fs.rename(file, target);
        }),
      ).pipe(
        Effect.mapError(() => new BlobStoreError({ operation: "put" })),
        Effect.provide(NodeServices.layer),
      ),
    remove: (key) =>
      Effect.gen(function* () {
        const found = yield* location(key, false);
        if (found !== undefined) yield* found.fs.remove(found.target, { force: true });
      }).pipe(
        Effect.mapError(() => new BlobStoreError({ operation: "remove" })),
        Effect.provide(NodeServices.layer),
      ),
  };
};
