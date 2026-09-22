/** Alchemy owns the R2 binding; the SDK receives only its portable blob contract. */
import { BlobStore, BlobStoreError } from "@executor-js/sdk/core";
import { RuntimeContext } from "alchemy";
import { retain } from "alchemy/RemovalPolicy";
import * as Cloudflare from "alchemy/Cloudflare";
import { Effect, Option } from "effect";
import { testStage } from "./stage.ts";

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
        Effect.mapError(() => new BlobStoreError({ operation: "get" })),
      ),
    put: (key, body) =>
      bucket.put(key, body).pipe(
        Effect.asVoid,
        Effect.provide(RuntimeContext.phantom),
        Effect.mapError(() => new BlobStoreError({ operation: "put" })),
      ),
    remove: (key) =>
      bucket.delete(key).pipe(
        Effect.asVoid,
        Effect.provide(RuntimeContext.phantom),
        Effect.mapError(() => new BlobStoreError({ operation: "remove" })),
      ),
  });
}).pipe(Effect.provide(Cloudflare.R2.ReadWriteBucketBinding));
