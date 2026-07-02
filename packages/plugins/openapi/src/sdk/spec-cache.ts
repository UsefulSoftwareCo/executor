import { Clock, Duration, Effect, Predicate } from "effect";
import type { Layer } from "effect";
import type { HttpClient } from "effect/unstable/http";

import { sha256Hex, type StorageFailure } from "@executor-js/sdk/core";

import type { OpenApiParseError } from "./errors";
import { fetchSpecDocument, fetchSpecText, type SpecFetchValidators } from "./parse";
import type { OpenapiStore, SpecSourceEntry } from "./store";

// ---------------------------------------------------------------------------
// Cached spec fetch — the URL-keyed index over the content-addressed blob
// store. The blob store alone can't skip a download (its key is the SHA-256 of
// the body, unknowable before fetching), so the `spec_source` index remembers
// what each URL last resolved to plus the response's cache validators:
//
//   fresh entry (within TTL)  -> serve the spec blob, no network
//   stale entry w/ validators -> conditional GET; 304 revalidates the blob
//   miss / changed upstream   -> full download, blob + index updated
//
// Spec fetches are unauthenticated by design (see fetchSpecDocument), so one
// org-shared entry per tenant is safe. Preview persists through this path too,
// which is what makes the add flow's preview -> addSpec sequence a single
// download instead of two: an abandoned preview leaves only an unreferenced
// content-addressed blob, the same accepted cost as an aborted addSpec.
// ---------------------------------------------------------------------------

/** How long a cached fetch keeps serving without touching the network. Sized
 *  for the add flow (debounced previews, preview -> add) — not a freshness
 *  contract for refresh, which revalidates unconditionally. */
export const SPEC_FETCH_TTL = Duration.minutes(5);

export type SpecFetchFreshness =
  /** Serve a within-TTL cache entry without any network round trip. */
  | "prefer-cache"
  /** Always hit the network; validators still turn an unchanged spec into a
   *  bodyless 304. The explicit-refresh (`updateSpec`) mode. */
  | "revalidate";

export interface ResolvedSpecDocument {
  readonly specText: string;
  readonly specHash: string;
  /** True when the spec blob is known to already be in the store (cache hit or
   *  this call wrote it) — lets callers skip a redundant multi-MB re-put. */
  readonly persisted: boolean;
}

/**
 * Fetch a spec URL through the tenant's `spec_source` cache. Storage failures
 * on the write-back are surfaced (a broken store should fail loudly, not
 * silently double-fetch forever).
 */
export const fetchSpecTextCached = (input: {
  readonly url: string;
  readonly storage: OpenapiStore;
  readonly httpClientLayer: Layer.Layer<HttpClient.HttpClient>;
  readonly freshness: SpecFetchFreshness;
}): Effect.Effect<ResolvedSpecDocument, OpenApiParseError | StorageFailure> =>
  Effect.gen(function* () {
    const now = yield* Clock.currentTimeMillis;
    const entry = yield* input.storage.getSpecSource(input.url);

    if (
      entry !== null &&
      input.freshness === "prefer-cache" &&
      now - entry.fetchedAt < Duration.toMillis(SPEC_FETCH_TTL)
    ) {
      const cached = yield* input.storage.getSpec(entry.specHash);
      // A missing blob (pruned out-of-band) falls through to a full fetch.
      if (cached !== null) {
        return { specText: cached, specHash: entry.specHash, persisted: true };
      }
    }

    const validators: SpecFetchValidators | undefined =
      entry !== null && (entry.etag !== undefined || entry.lastModified !== undefined)
        ? {
            ...(entry.etag !== undefined ? { etag: entry.etag } : {}),
            ...(entry.lastModified !== undefined ? { lastModified: entry.lastModified } : {}),
          }
        : undefined;

    const conditional = yield* fetchSpecDocument(input.url, validators).pipe(
      Effect.provide(input.httpClientLayer),
    );

    if (Predicate.isTagged(conditional, "NotModified") && entry !== null) {
      const cached = yield* input.storage.getSpec(entry.specHash);
      if (cached !== null) {
        yield* putSpecSourceRaceSafe(input.storage, { ...entry, fetchedAt: now });
        return { specText: cached, specHash: entry.specHash, persisted: true };
      }
    }

    // 304 with the blob gone is a broken-index corner: refetch for real. The
    // unconditional fetchSpecText fails typed on a (protocol-violating) bare 304.
    const fetched: {
      readonly text: string;
      readonly etag?: string;
      readonly lastModified?: string;
    } = Predicate.isTagged(conditional, "Fetched")
      ? conditional
      : { text: yield* fetchSpecText(input.url).pipe(Effect.provide(input.httpClientLayer)) };

    const specHash = yield* sha256Hex(fetched.text);
    yield* input.storage.putSpec(specHash, fetched.text);
    yield* putSpecSourceRaceSafe(input.storage, {
      url: input.url,
      specHash,
      ...(fetched.etag !== undefined ? { etag: fetched.etag } : {}),
      ...(fetched.lastModified !== undefined ? { lastModified: fetched.lastModified } : {}),
      fetchedAt: now,
    });
    return { specText: fetched.text, specHash, persisted: true };
  }).pipe(
    Effect.withSpan("openapi.spec_cache.fetch", {
      attributes: { "openapi.spec.url": input.url },
    }),
  );

// Two debounced previews of the same URL can race the first insert; the loser's
// unique violation is harmless (the winner just wrote an equivalent entry).
const putSpecSourceRaceSafe = (storage: OpenapiStore, entry: SpecSourceEntry) =>
  storage.putSpecSource(entry).pipe(Effect.catchTag("UniqueViolationError", () => Effect.void));
