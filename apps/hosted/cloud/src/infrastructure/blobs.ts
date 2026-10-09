/** Alchemy owns the R2 binding; the SDK receives only its portable blob contract. */
import { BlobStore, BlobStoreError, type AppCodeId } from "@executor-js/sdk/core";
import { RuntimeContext } from "alchemy";
import { retain } from "alchemy/RemovalPolicy";
import * as Cloudflare from "alchemy/Cloudflare";
import { Effect, Option } from "effect";
import { testStage } from "./stage.ts";
import { providerFailureCode } from "../implementation/provider-failure.ts";
import { persistR2Object } from "../implementation/r2-write.ts";
import type { WorkspaceObjects } from "../implementation/workspace-cache.ts";

/** Configured stages keep retained builds; a destroyed test stage leaves nothing behind. */
export const AppBuilds = Cloudflare.R2.Bucket(
  "AppBuilds",
  testStage.pipe(
    Effect.map((stage) => ({ forceDestroy: Option.isSome(stage) })),
    Effect.orDie,
  ),
).pipe(retain(testStage.pipe(Effect.map(Option.isNone), Effect.orDie)));

/** Resolve a binding at composition; storage I/O executes in the current Worker invocation. */
export const cloudBlobs = Effect.gen(function* () {
  const bucket = yield* Cloudflare.R2.ReadWriteBucket(AppBuilds);
  return BlobStore.of({
    get: (key) =>
      Effect.gen(function* () {
        const object = yield* bucket.get(key);
        if (object === null) return Option.none();
        return Option.some(new Uint8Array(yield* object.arrayBuffer()));
      }).pipe(
        Effect.provide(RuntimeContext.phantom),
        Effect.tapError((error) =>
          Effect.annotateCurrentSpan({ "storage.blob.failure.code": providerFailureCode(error) }),
        ),
        Effect.mapError(() => new BlobStoreError({ operation: "get" })),
      ),
    exists: (key) =>
      bucket.head(key).pipe(
        Effect.map((object) => object !== null),
        Effect.provide(RuntimeContext.phantom),
        Effect.tapError((error) =>
          Effect.annotateCurrentSpan({ "storage.blob.failure.code": providerFailureCode(error) }),
        ),
        Effect.mapError(() => new BlobStoreError({ operation: "exists" })),
      ),
    put: (key, body) =>
      bucket.put(key, body).pipe(
        // Builds own UUID keys; onboarding icons use content hashes. Rejected
        // writes can repeat the same complete bytes without replaying app work.
        persistR2Object,
        Effect.asVoid,
        Effect.provide(RuntimeContext.phantom),
        Effect.tapError((error) =>
          Effect.annotateCurrentSpan({ "storage.blob.failure.code": providerFailureCode(error) }),
        ),
        Effect.mapError(() => new BlobStoreError({ operation: "put" })),
      ),
    remove: (key) =>
      bucket.delete(key).pipe(
        Effect.asVoid,
        Effect.provide(RuntimeContext.phantom),
        Effect.tapError((error) =>
          Effect.annotateCurrentSpan({ "storage.blob.failure.code": providerFailureCode(error) }),
        ),
        Effect.mapError(() => new BlobStoreError({ operation: "remove" })),
      ),
  });
}).pipe(Effect.provide(Cloudflare.R2.ReadWriteBucketBinding));

/**
 * Retained builds for the AppData Worker, which only reads them. Its binding client has no write
 * methods, so a write is refused here instead of reaching storage.
 */
export const cloudBuildReader = Effect.gen(function* () {
  const bucket = yield* Cloudflare.R2.ReadBucket(AppBuilds);
  const observe =
    (operation: "get" | "exists") =>
    <A, E, R>(effect: Effect.Effect<A, E, R>) =>
      effect.pipe(
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
  });
}).pipe(Effect.provide(Cloudflare.R2.ReadBucketBinding));

/** One mutable object per app code, beside its immutable initial files. R2 versions fence writers. */
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
      }).pipe(Effect.provide(RuntimeContext.phantom), observe("get")),
    put: (code, body) =>
      bucket.put(key(code), body).pipe(
        // Only a failed precondition returns null, and this write has none.
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
