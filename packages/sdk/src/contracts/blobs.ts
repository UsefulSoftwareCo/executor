/** Host-owned binary persistence, independent of SQL and execution platform. */
import { Context, type Effect, type Option, Schema, type Stream } from "effect";

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
  operation: Schema.Literals(["get", "exists", "put", "remove", "list"]),
  /** The store's unexpected HTTP status, when it answered with one. */
  status: Schema.optionalKey(Schema.Int),
  /** The underlying failure, kept for diagnosis. */
  cause: Schema.optionalKey(Schema.Defect()),
}) {}

/** `length` bytes from `offset`. Readers clamp a range that runs past the object's end. */
export interface BlobRange {
  readonly offset: number;
  readonly length: number;
}

/** A streamed object: its whole size, and the requested bytes. */
export interface BlobBody {
  readonly size: number;
  readonly body: Stream.Stream<Uint8Array, BlobStoreError>;
}

/** One page of object names in a folder. */
export interface BlobListing {
  readonly names: ReadonlyArray<string>;
  readonly truncated: boolean;
}

/** Each successful put publishes the complete object. Remove is idempotent. No public URLs or authorization live here. */
export interface BlobStorage {
  readonly get: (key: BlobKey) => Effect.Effect<Option.Option<Uint8Array>, BlobStoreError>;
  /** Whether a complete object is stored, without reading its bytes. */
  readonly exists: (key: BlobKey) => Effect.Effect<boolean, BlobStoreError>;
  readonly put: (key: BlobKey, body: Uint8Array) => Effect.Effect<void, BlobStoreError>;
  readonly remove: (key: BlobKey) => Effect.Effect<void, BlobStoreError>;
  /**
   * Names of the objects directly inside `folder` (`<folder>/<name>`) that sort after
   * `startAfter`, in ascending order, at most `limit` of them. `truncated` says more follow.
   */
  readonly list: (
    folder: BlobKey,
    options: { readonly startAfter?: string | undefined; readonly limit: number },
  ) => Effect.Effect<BlobListing, BlobStoreError>;
  /** Stream an object, or one range of it, without holding it in memory. */
  readonly stream: (
    key: BlobKey,
    range?: BlobRange,
  ) => Effect.Effect<Option.Option<BlobBody>, BlobStoreError>;
}

/** Provided by createExecutor; runtimes resolve this service when an operation runs. */
export class BlobStore extends Context.Service<BlobStore, BlobStorage>()("executor/BlobStore") {}
