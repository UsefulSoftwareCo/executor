import {
  BlobStore,
  BlobStoreError,
  type AppCodeId,
  type BlobKey,
  type BlobRange,
} from "@executor-js/sdk/core";
import { RuntimeContext } from "alchemy";
import { retain } from "alchemy/RemovalPolicy";
import * as Cloudflare from "alchemy/Cloudflare";
import { Effect, Option, Stream } from "effect";
import { testStage } from "./stage.ts";
import { providerFailureCode } from "../implementation/provider-failure.ts";
import { readR2Object } from "../implementation/r2-read.ts";
import { writeR2Object } from "../implementation/r2-write.ts";
import type { WorkspaceObjects } from "../implementation/workspace-cache.ts";

export const AppBuilds = Cloudflare.R2.Bucket(
  "AppBuilds",
  testStage.pipe(
    Effect.map((stage) => ({ forceDestroy: Option.isSome(stage) })),
    Effect.orDie,
  ),
).pipe(retain(testStage.pipe(Effect.map(Option.isNone), Effect.orDie)));

type ReadClient = Effect.Success<ReturnType<typeof Cloudflare.R2.ReadBucket>>;
type WriteClient = Effect.Success<ReturnType<typeof Cloudflare.R2.ReadWriteBucket>>;

const listFolder = (
  bucket: ReadClient,
  folder: BlobKey,
  options: { readonly startAfter?: string | undefined; readonly limit: number },
) =>
  bucket
    .list({
      prefix: `${folder}/`,
      delimiter: "/",
      limit: options.limit,
      ...(options.startAfter === undefined
        ? {}
        : { startAfter: `${folder}/${options.startAfter}` }),
    })
    .pipe(
      Effect.map((page) => ({
        names: page.objects.map((object) => object.key.slice(folder.length + 1)),
        truncated: page.truncated,
      })),
      readR2Object,
      Effect.provide(RuntimeContext.phantom),
      Effect.tapError((error) =>
        Effect.annotateCurrentSpan({ "storage.blob.failure.code": providerFailureCode(error) }),
      ),
      Effect.mapError(() => new BlobStoreError({ operation: "list" })),
    );

const streamObject = (bucket: ReadClient, key: BlobKey, range: BlobRange | undefined) =>
  Effect.gen(function* () {
    if (range !== undefined && range.length === 0) {
      const head = yield* bucket.head(key);
      return head === null ? Option.none() : Option.some({ size: head.size, body: Stream.empty });
    }
    const object = yield* bucket.get(
      key,
      range === undefined ? undefined : { range: { offset: range.offset, length: range.length } },
    );
    if (object === null) return Option.none();
    return Option.some({
      size: object.size,
      body: object.body.pipe(Stream.mapError(() => new BlobStoreError({ operation: "get" }))),
    });
  }).pipe(
    readR2Object,
    Effect.provide(RuntimeContext.phantom),
    Effect.tapError((error) =>
      Effect.annotateCurrentSpan({ "storage.blob.failure.code": providerFailureCode(error) }),
    ),
    Effect.mapError(() => new BlobStoreError({ operation: "get" })),
  );

const removeObjects = (bucket: WriteClient, keys: string | string[]) =>
  bucket.delete(keys).pipe(
    Effect.asVoid,
    Effect.provide(RuntimeContext.phantom),
    Effect.tapError((error) =>
      Effect.annotateCurrentSpan({ "storage.blob.failure.code": providerFailureCode(error) }),
    ),
    Effect.mapError(() => new BlobStoreError({ operation: "remove" })),
  );

export const cloudBlobs = Effect.gen(function* () {
  const bucket = yield* Cloudflare.R2.ReadWriteBucket(AppBuilds);
  return BlobStore.of({
    get: (key) =>
      Effect.gen(function* () {
        const object = yield* bucket.get(key);
        if (object === null) return Option.none();
        return Option.some(new Uint8Array(yield* object.arrayBuffer()));
      }).pipe(
        readR2Object,
        Effect.provide(RuntimeContext.phantom),
        Effect.tapError((error) =>
          Effect.annotateCurrentSpan({ "storage.blob.failure.code": providerFailureCode(error) }),
        ),
        Effect.mapError(() => new BlobStoreError({ operation: "get" })),
      ),
    exists: (key) =>
      bucket.head(key).pipe(
        Effect.map((object) => object !== null),
        readR2Object,
        Effect.provide(RuntimeContext.phantom),
        Effect.tapError((error) =>
          Effect.annotateCurrentSpan({ "storage.blob.failure.code": providerFailureCode(error) }),
        ),
        Effect.mapError(() => new BlobStoreError({ operation: "exists" })),
      ),
    put: (key, body) =>
      bucket.put(key, body).pipe(Effect.provide(RuntimeContext.phantom), writeR2Object),
    remove: (key) => removeObjects(bucket, key),
    removeAll: (keys) => (keys.length === 0 ? Effect.void : removeObjects(bucket, [...keys])),
    list: (folder, options) => listFolder(bucket, folder, options),
    stream: (key, range) => streamObject(bucket, key, range),
  });
}).pipe(Effect.provide(Cloudflare.R2.ReadWriteBucketBinding));

export const cloudBuildReader = Effect.gen(function* () {
  const bucket = yield* Cloudflare.R2.ReadBucket(AppBuilds);
  const observe =
    (operation: "get" | "exists") =>
    <A, E, R>(effect: Effect.Effect<A, E, R>) =>
      effect.pipe(
        readR2Object,
        Effect.provide(RuntimeContext.phantom),
        Effect.tapError((error) =>
          Effect.annotateCurrentSpan({ "storage.blob.failure.code": providerFailureCode(error) }),
        ),
        Effect.mapError(() => new BlobStoreError({ operation })),
      );
  return BlobStore.of({
    get: (key) =>
      Effect.gen(function* () {
        const object = yield* bucket.get(key);
        if (object === null) return Option.none();
        return Option.some(new Uint8Array(yield* object.arrayBuffer()));
      }).pipe(observe("get")),
    exists: (key) =>
      bucket.head(key).pipe(
        Effect.map((object) => object !== null),
        observe("exists"),
      ),
    put: () => Effect.fail(new BlobStoreError({ operation: "put" })),
    remove: () => Effect.fail(new BlobStoreError({ operation: "remove" })),
    removeAll: () => Effect.fail(new BlobStoreError({ operation: "remove" })),
    list: (folder, options) => listFolder(bucket, folder, options),
    stream: (key, range) => streamObject(bucket, key, range),
  });
}).pipe(Effect.provide(Cloudflare.R2.ReadBucketBinding));

export const cloudWorkspaceObjects = Effect.gen(function* () {
  const bucket = yield* Cloudflare.R2.ReadWriteBucket(AppBuilds);
  const key = (code: AppCodeId) => `app-source/${code}/workspace.json`;
  const observe =
    (operation: "get" | "put") =>
    <A, E, R>(effect: Effect.Effect<A, E, R>) =>
      effect.pipe(
        Effect.tapError((error) =>
          Effect.annotateCurrentSpan({ "storage.blob.failure.code": providerFailureCode(error) }),
        ),
        Effect.mapError(() => new BlobStoreError({ operation })),
      );
  return {
    get: (code) =>
      Effect.gen(function* () {
        const object = yield* bucket.get(key(code));
        if (object === null) return Option.none();
        return Option.some({ etag: object.etag, body: yield* object.bytes() });
      }).pipe(readR2Object, Effect.provide(RuntimeContext.phantom), observe("get")),
    put: (code, body) =>
      bucket.put(key(code), body).pipe(
        Effect.flatMap((object) =>
          object === null
            ? Effect.fail(new BlobStoreError({ operation: "put" }))
            : Effect.succeed(object.etag),
        ),
        Effect.provide(RuntimeContext.phantom),
        observe("put"),
      ),
    replace: (code, body, etag) =>
      bucket.put(key(code), body, { onlyIf: { etagMatches: etag } }).pipe(
        Effect.map((object) => object !== null),
        Effect.provide(RuntimeContext.phantom),
        observe("put"),
      ),
  } satisfies WorkspaceObjects;
}).pipe(Effect.provide(Cloudflare.R2.ReadWriteBucketBinding));
