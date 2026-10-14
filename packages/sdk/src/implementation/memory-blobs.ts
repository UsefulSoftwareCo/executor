import { Effect, Option } from "effect";
import type { BlobKey, BlobStorage } from "../contracts/blobs.ts";
import { bufferedBody, pageOf } from "./blob-streams.ts";

/** Explicit ephemeral storage for tests and disposable hosts. Returned bytes never alias retained bytes. */
export const memoryBlobStore = (): BlobStorage => {
  const objects = new Map<BlobKey, Uint8Array>();
  return {
    get: (key) => Effect.sync(() => Option.fromNullishOr(objects.get(key)?.slice())),
    exists: (key) => Effect.sync(() => objects.has(key)),
    put: (key, body) =>
      Effect.sync(() => {
        objects.set(key, body.slice());
      }),
    remove: (key) =>
      Effect.sync(() => {
        objects.delete(key);
      }),
    list: (folder, options) =>
      Effect.sync(() =>
        pageOf(
          [...objects.keys()]
            .filter((key) => key.startsWith(`${folder}/`))
            .map((key) => key.slice(folder.length + 1))
            .filter((name) => !name.includes("/")),
          options,
        ),
      ),
    stream: (key, range) =>
      Effect.sync(() =>
        Option.map(Option.fromNullishOr(objects.get(key)), (bytes) => bufferedBody(bytes, range)),
      ),
  };
};
