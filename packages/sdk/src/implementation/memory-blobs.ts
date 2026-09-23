import { Effect, Option } from "effect";
import type { BlobKey, BlobStorage } from "../contracts/blobs.ts";

/** Explicit ephemeral storage for tests and disposable hosts. Returned bytes never alias retained bytes. */
export const memoryBlobStore = (): BlobStorage => {
  const objects = new Map<BlobKey, Uint8Array>();
  return {
    get: (key) => Effect.sync(() => Option.fromNullishOr(objects.get(key)?.slice())),
    put: (key, body) =>
      Effect.sync(() => {
        objects.set(key, body.slice());
      }),
    remove: (key) =>
      Effect.sync(() => {
        objects.delete(key);
      }),
  };
};
