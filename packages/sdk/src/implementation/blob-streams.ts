/** Shared pieces of streamed blob reads, folder listings and removals, for every store adapter. */
import { Effect, Result, Stream } from "effect";
import { BlobStoreError, type BlobBody, type BlobKey, type BlobRange } from "../contracts/blobs.ts";

/** The clamped byte window a range selects in an object of `size` bytes. */
export const rangeWindow = (size: number, range: BlobRange | undefined) => {
  const start = Math.min(range?.offset ?? 0, size);
  const end = range === undefined ? size : Math.min(start + range.length, size);
  return { start, end };
};

/** A buffered object served through the streaming contract. */
export const bufferedBody = (bytes: Uint8Array, range: BlobRange | undefined): BlobBody => {
  const { start, end } = rangeWindow(bytes.length, range);
  return { size: bytes.length, body: Stream.make(bytes.slice(start, end)) };
};

/** The bytes of a whole-object stream between `start` and `end`, for stores without range reads. */
export const windowed = <E>(stream: Stream.Stream<Uint8Array, E>, start: number, end: number) => {
  let position = 0;
  return stream.pipe(
    Stream.takeWhile(() => position < end),
    Stream.map((chunk) => {
      const from = position;
      position += chunk.byteLength;
      return chunk.subarray(
        Math.max(0, start - from),
        Math.max(0, Math.min(chunk.byteLength, end - from)),
      );
    }),
    Stream.filter((chunk) => chunk.byteLength > 0),
  );
};

/** One page of a folder whose every name is known, for stores without paged listing. */
export const pageOf = (
  names: ReadonlyArray<string>,
  options: { readonly startAfter?: string | undefined; readonly limit: number },
) => {
  const after = options.startAfter;
  const sorted = names.filter((name) => after === undefined || name > after).sort();
  return { names: sorted.slice(0, options.limit), truncated: sorted.length > options.limit };
};

/**
 * `removeAll` for a store that removes one key per request: every key is tried even after one
 * fails, and the call then fails if any did, so one failed request leaves only its own object.
 */
export const removeEach = (
  keys: ReadonlyArray<BlobKey>,
  remove: (key: BlobKey) => Effect.Effect<void, BlobStoreError>,
) =>
  Effect.forEach(keys, (key) => Effect.result(remove(key)), { concurrency: 8 }).pipe(
    Effect.flatMap((results) =>
      results.some(Result.isFailure)
        ? Effect.fail(new BlobStoreError({ operation: "remove" }))
        : Effect.void,
    ),
  );
