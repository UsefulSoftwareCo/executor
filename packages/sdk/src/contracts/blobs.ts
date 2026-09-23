/** Host-owned binary persistence, independent of SQL and execution platform. */
import { Context, type Effect, type Option, Schema } from "effect";

/** Canonical relative object keys. Filesystem adapters also enforce their root boundary. */
export const BlobKey = Schema.String.check(
  Schema.makeFilter(
    (key) =>
      key.length > 0 &&
      !key.includes("\\") &&
      [...key].every(
        (character) => character.charCodeAt(0) >= 32 && character.charCodeAt(0) !== 127,
      ) &&
      key.split("/").every((part) => part !== "" && part !== "." && part !== ".."),
  ),
).pipe(Schema.brand("BlobKey"));
export type BlobKey = typeof BlobKey.Type;

/** Missing objects are ordinary results; storage failures must not look like absence. */
export class BlobStoreError extends Schema.TaggedError<BlobStoreError>()("BlobStoreError", {
  operation: Schema.Literals(["get", "put", "remove"]),
}) {}

/** Each successful put publishes the complete object. Remove is idempotent. No public URLs or authorization live here. */
export interface BlobStorage {
  readonly get: (key: BlobKey) => Effect.Effect<Option.Option<Uint8Array>, BlobStoreError>;
  readonly put: (key: BlobKey, body: Uint8Array) => Effect.Effect<void, BlobStoreError>;
  readonly remove: (key: BlobKey) => Effect.Effect<void, BlobStoreError>;
}

/** Provided by createExecutor; runtimes resolve this service when an operation runs. */
export class BlobStore extends Context.Service<BlobStore, BlobStorage>()("executor/BlobStore") {}
