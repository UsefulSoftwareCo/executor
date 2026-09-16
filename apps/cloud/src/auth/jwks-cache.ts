// ---------------------------------------------------------------------------
// JWKS cache for JWT verification (session + MCP auth).
// ---------------------------------------------------------------------------
//
// Cloudflare Workers boot many short-lived isolates. `createRemoteJWKSet`'s
// default cooldown (30s) and cache max-age (10m) still results in many JWKS
// fetches per hour because each new isolate starts cold. Production p99 for
// `mcp.auth.jwt_verify` was 1.7s — almost entirely the JWKS fetch.
//
// Module-scope memory alone only helps while an isolate stays warm. When
// `workos.session.local_verify` started missing ~92% of the time (2026-08-18),
// every miss paid a fresh upstream fetch — p50 3s, and the tail crossed the 5s
// request timeout, turning a slow key-server into `AbortError` → 500 on every
// authenticated API route and 503 on `/mcp`. A transient key-server blip must
// never read as an auth failure, and a cold isolate must not have to go
// upstream at all.
//
// So this module layers three caches, fastest first:
//
//   1. Module-scope memory — free, but dies with the isolate.
//   2. A cross-isolate store (the Workers Cache API by default) — colo-local,
//      survives isolate recycling, so a cold isolate still has keys when the
//      upstream key server is slow or down.
//   3. The upstream JWKS endpoint.
//
// On top of that it is stale-while-revalidate: once past `ttlMs` a usable key
// set is served immediately and refreshed in the background, and if a refresh
// fails we keep serving the last good keys until `staleMaxMs`.
//
// A cold isolate (no memory) RACES the store read against the upstream fetch
// and takes whichever answers first. The store was added as the fast path,
// but production measured the opposite: `caches.default.match()` on a cold
// isolate takes p50 1.4s / p90 2.8s while the upstream fetch takes p50 26ms
// (`jwks.store_read_ms` vs `jwks.last_fetch_ms` on `workos.session.local_verify`,
// 2026-09). Waiting on the store first put 1.5s on every cold verify — the
// single largest cost of a cold API request. Racing keeps the store's purpose
// (keys survive a slow or dead key server) without its latency: the store
// only decides the outcome when the upstream is slower than it, which is
// exactly the incident it exists for.
//
// Serving stale keys is safe in a way that serving a stale *token* would not
// be: key sets rotate on the order of days, tokens are still signature- and
// expiry-checked against them, and a token whose `kid` is absent forces a real
// refresh before it is rejected (see `get`). `staleMaxMs` bounds how long a
// retired key can still be honoured.
//
// The returned function is a `JWTVerifyGetKey` and slots directly into
// `jose.jwtVerify`. It also exposes `forceRefresh()` so the verify path can
// invalidate the cache and retry on a bad signature.
// ---------------------------------------------------------------------------

import {
  createLocalJWKSet,
  type FlattenedJWSInput,
  type JSONWebKeySet,
  type JWTHeaderParameters,
  type JWTVerifyGetKey,
  type KeyLike,
} from "jose";
import { Schema } from "effect";
import { JWKSNoMatchingKey } from "jose/errors";

/**
 * A cross-isolate key-set store. Defaults to the Workers Cache API; tests and
 * non-Workers hosts pass their own, or `null` to stay memory-only.
 */
export interface JwksStore {
  readonly get: (url: URL) => Promise<StoredJwks | null>;
  readonly put: (url: URL, stored: StoredJwks) => Promise<void>;
}

export interface StoredJwks {
  readonly jwks: JSONWebKeySet;
  /** Epoch ms of the upstream fetch these keys came from. */
  readonly fetchedAt: number;
}

export interface CachedRemoteJWKSetOptions {
  /**
   * How long a successful fetch is considered fresh. Defaults to 1 hour —
   * AuthKit rotates JWKS roughly daily, and a forced refresh on verify
   * failure handles unscheduled rotations.
   */
  readonly ttlMs?: number;
  /**
   * How long past `ttlMs` a key set may still be served while refreshes are
   * failing. Defaults to 24h — long enough to ride out a key-server outage,
   * short enough to bound how long a retired key stays honoured.
   */
  readonly staleMaxMs?: number;
  /** Override the fetch implementation for tests. */
  readonly fetch?: typeof globalThis.fetch;
  /** HTTP request timeout. Defaults to 5s, matching jose. */
  readonly timeoutMs?: number;
  /**
   * Cross-isolate store. Defaults to the Workers Cache API when available,
   * `null` disables the layer (memory-only).
   */
  readonly store?: JwksStore | null;
}

export interface CachedRemoteJWKSet extends JWTVerifyGetKey {
  /** Drop the cached JWKS so the next call refetches. */
  readonly forceRefresh: () => void;
  /**
   * Inspect the current cache state (testing/diagnostics/span annotation).
   * `fetchCount`/`fetchFailureCount` are lifetime counters for this resolver
   * instance; callers snapshot them around a verify to tell a cache hit from
   * a live upstream fetch (the Aug 2026 latency regression was exactly this
   * cache silently missing on ~92% of verifies, invisible in traces).
   *
   * `blockingFetchCount` counts only fetches a verify actually WAITED on.
   * Under stale-while-revalidate `fetchCount` also moves for background
   * revalidation the caller never paid for, so latency attribution wants
   * `blockingFetchCount`. `storeHitCount` counts cold-isolate reads answered
   * by the cross-isolate store instead of going upstream.
   */
  readonly inspect: () => {
    fetchedAt: number | null;
    hasJwks: boolean;
    fetchCount: number;
    fetchFailureCount: number;
    blockingFetchCount: number;
    storeHitCount: number;
    lastFetchDurationMs: number | null;
    /** Wall-clock of the last cross-isolate store read (I/O). */
    lastStoreReadMs: number | null;
    /** Wall-clock of the last key resolution — WebCrypto `importKey`. */
    lastResolveMs: number | null;
  };
}

const DEFAULT_TTL_MS = 60 * 60 * 1000;
const DEFAULT_STALE_MAX_MS = 24 * 60 * 60 * 1000;
const DEFAULT_TIMEOUT_MS = 5000;

const JsonWebKey = Schema.Record(Schema.String, Schema.Unknown);
const JsonWebKeySetPayload = Schema.Struct({
  keys: Schema.Array(JsonWebKey),
});
const decodeJsonWebKeySetPayload = Schema.decodeUnknownPromise(JsonWebKeySetPayload);

const ErrorWithCode = Schema.Struct({ code: Schema.String });
const isErrorWithCode = Schema.is(ErrorWithCode);

const isJwksNoMatchingKey = (cause: unknown): boolean =>
  isErrorWithCode(cause) && cause.code === JWKSNoMatchingKey.code;

interface CacheEntry {
  jwks: JSONWebKeySet;
  fetchedAt: number;
  resolver: (protectedHeader: JWTHeaderParameters, token?: FlattenedJWSInput) => Promise<KeyLike>;
}

const entryFrom = (stored: StoredJwks): CacheEntry => ({
  jwks: stored.jwks,
  fetchedAt: stored.fetchedAt,
  resolver: createLocalJWKSet(stored.jwks),
});

/**
 * Cache upkeep (store writes, background revalidation) is best effort: it must
 * never fail or delay the verify that happened to trigger it.
 */
const ignoreFailure = async (work: Promise<unknown>): Promise<void> => {
  // oxlint-disable-next-line executor/no-try-catch-or-throw -- boundary: best-effort cache upkeep must not surface as a verify failure
  try {
    await work;
  } catch {
    // Deliberately swallowed — the caller already has usable keys, or will
    // take the upstream path on its next miss.
  }
};

const fetchJwksOnce = async (
  url: URL,
  fetchImpl: typeof globalThis.fetch,
  timeoutMs: number,
): Promise<JSONWebKeySet> => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  // oxlint-disable-next-line executor/no-try-catch-or-throw -- boundary: fetch adapter must clear abort timer while preserving promise rejection behavior
  try {
    const response = await fetchImpl(url.toString(), {
      method: "GET",
      headers: { accept: "application/json" },
      signal: controller.signal,
    });

    if (!response.ok) {
      // oxlint-disable-next-line executor/no-try-catch-or-throw, executor/no-error-constructor -- boundary: fetch-backed JWT key resolver must reject with the existing Error cause shape
      throw new Error(`JWKS fetch failed: ${response.status} ${response.statusText}`);
    }

    const body = await response.json();
    // oxlint-disable-next-line executor/no-try-catch-or-throw -- boundary: fetch JSON validation maps Schema failures to the existing malformed JWKS rejection
    try {
      await decodeJsonWebKeySetPayload(body);
      return body as JSONWebKeySet;
    } catch {
      // oxlint-disable-next-line executor/no-try-catch-or-throw, executor/no-error-constructor -- boundary: fetch JSON validation preserves the existing malformed JWKS rejection
      throw new Error("JWKS fetch returned malformed payload");
    }
  } finally {
    clearTimeout(timer);
  }
};

// ---------------------------------------------------------------------------
// Workers Cache API store
// ---------------------------------------------------------------------------
//
// Keyed by the JWKS URL itself. We store our own Response rather than the
// upstream one so the body is already-validated JSON and the cache headers are
// ours: `max-age` covers the stale window, because an entry past `ttlMs` is
// still useful to us as a stale fallback.

const STORE_HEADER_FETCHED_AT = "x-jwks-fetched-at";

/** `caches.default` is a Workers extension the standard lib type omits. */
type WorkersCacheStorage = CacheStorage & { readonly default?: Cache };

const workersCacheStore = (staleMaxMs: number): JwksStore | null => {
  if (typeof caches === "undefined") return null;
  const open = (): Cache | null => (caches as WorkersCacheStorage).default ?? null;

  return {
    get: async (url) => {
      const cache = open();
      if (!cache) return null;
      const hit = await cache.match(url.toString());
      if (!hit) return null;
      const fetchedAtHeader = hit.headers.get(STORE_HEADER_FETCHED_AT);
      const fetchedAt = fetchedAtHeader === null ? Number.NaN : Number(fetchedAtHeader);
      if (!Number.isFinite(fetchedAt)) return null;
      const body = await hit.json();
      // oxlint-disable-next-line executor/no-try-catch-or-throw -- boundary: a corrupt cache entry must degrade to a miss, never fail the verify
      try {
        await decodeJsonWebKeySetPayload(body);
      } catch {
        return null;
      }
      return { jwks: body as JSONWebKeySet, fetchedAt };
    },
    put: async (url, stored) => {
      const cache = open();
      if (!cache) return;
      const maxAgeSeconds = Math.max(1, Math.floor(staleMaxMs / 1000));
      await cache.put(
        url.toString(),
        new Response(JSON.stringify(stored.jwks), {
          status: 200,
          headers: {
            "content-type": "application/json",
            "cache-control": `max-age=${maxAgeSeconds}`,
            [STORE_HEADER_FETCHED_AT]: String(stored.fetchedAt),
          },
        }),
      );
    },
  };
};

/**
 * Creates a cached, single-flight, force-refreshable JWKS resolver compatible
 * with `jose.jwtVerify`. Drop-in replacement for `createRemoteJWKSet` for the
 * auth paths — see module header for why we don't just use jose's built-in.
 */
export const createCachedRemoteJWKSet = (
  url: URL,
  options: CachedRemoteJWKSetOptions = {},
): CachedRemoteJWKSet => {
  const ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
  const staleMaxMs = Math.max(options.staleMaxMs ?? DEFAULT_STALE_MAX_MS, ttlMs);
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const store = options.store === undefined ? workersCacheStore(staleMaxMs) : options.store;
  // Capture the fetch impl lazily so consumers can swap globalThis.fetch
  // (tests do this) without us snapshotting a stale reference.
  const fetchImpl = (): typeof globalThis.fetch =>
    options.fetch ?? globalThis.fetch.bind(globalThis);

  let entry: CacheEntry | null = null;
  let inflight: Promise<CacheEntry> | null = null;
  let fetchCount = 0;
  let fetchFailureCount = 0;
  let blockingFetchCount = 0;
  let storeHitCount = 0;
  let lastFetchDurationMs: number | null = null;
  let lastStoreReadMs: number | null = null;
  let lastResolveMs: number | null = null;

  const isFresh = (candidate: CacheEntry): boolean => Date.now() - candidate.fetchedAt < ttlMs;
  const isUsable = (candidate: CacheEntry): boolean =>
    Date.now() - candidate.fetchedAt < staleMaxMs;

  const refresh = (): Promise<CacheEntry> => {
    if (inflight) return inflight;
    const startedAt = Date.now();
    fetchCount += 1;
    inflight = (async () => {
      const jwks = await fetchJwksOnce(url, fetchImpl(), timeoutMs);
      const next = entryFrom({ jwks, fetchedAt: Date.now() });
      entry = next;
      if (store) {
        await ignoreFailure(store.put(url, { jwks: next.jwks, fetchedAt: next.fetchedAt }));
      }
      return next;
    })()
      .then(
        (next) => next,
        (error: unknown) => {
          fetchFailureCount += 1;
          // oxlint-disable-next-line executor/no-try-catch-or-throw -- boundary: counting a fetch failure must preserve the original rejection for jose
          throw error;
        },
      )
      .finally(() => {
        lastFetchDurationMs = Date.now() - startedAt;
        inflight = null;
      });
    return inflight;
  };

  /** Fire-and-forget revalidation behind a stale hit. */
  const refreshInBackground = (): void => {
    void ignoreFailure(refresh());
  };

  /** Read the cross-isolate store. Pure: the caller decides whether the
   *  candidate becomes the resolver's entry (see `loadCold`). */
  const loadFromStore = async (): Promise<CacheEntry | null> => {
    if (!store) return null;
    // oxlint-disable-next-line executor/no-try-catch-or-throw -- boundary: the L2 store is an optimization; any failure degrades to an upstream fetch
    try {
      const storeReadStartedAt = Date.now();
      const stored = await store.get(url);
      lastStoreReadMs = Date.now() - storeReadStartedAt;
      if (!stored) return null;
      const candidate = entryFrom(stored);
      return isUsable(candidate) ? candidate : null;
    } catch {
      return null;
    }
  };

  /** A refresh the caller waits on — the only kind that costs it latency. */
  const refreshBlocking = (): Promise<CacheEntry> => {
    blockingFetchCount += 1;
    return refresh();
  };

  /** Adopt a store candidate unless a fresher entry landed in the meantime
   *  (the racing upstream fetch may have finished first). */
  const adoptFromStore = (candidate: CacheEntry): CacheEntry => {
    storeHitCount += 1;
    if (entry === null || entry.fetchedAt < candidate.fetchedAt) entry = candidate;
    return entry;
  };

  type ColdWinner =
    | { readonly source: "store"; readonly entry: CacheEntry }
    | { readonly source: "upstream"; readonly entry: CacheEntry };

  /**
   * The fully cold path: nothing in memory. Race the store read against the
   * upstream fetch (see the module header for why the store is not simply
   * read first) and answer with whichever produces usable keys first. The
   * loser keeps running: an upstream fetch that lands after a store hit still
   * refreshes memory and the store, so the isolate converges on fresh keys.
   *
   * Latency attribution: `blockingFetchCount` moves only when the caller's
   * answer actually came from upstream; a fetch that lost the race (or
   * failed) is background work the verify did not pay for.
   */
  const loadCold = async (): Promise<CacheEntry> => {
    const fromStore = loadFromStore();
    const fromUpstream = refresh().then(
      (next) => ({ ok: true as const, entry: next }),
      (error: unknown) => ({ ok: false as const, error }),
    );
    const first = await Promise.race<ColdWinner | null>([
      fromStore.then((candidate) => (candidate ? { source: "store", entry: candidate } : null)),
      fromUpstream.then((result) =>
        result.ok ? { source: "upstream", entry: result.entry } : null,
      ),
    ]);
    if (first?.source === "upstream") {
      blockingFetchCount += 1;
      return first.entry;
    }
    if (first?.source === "store") {
      return adoptFromStore(first.entry);
    }
    // The first to settle had nothing: wait for the other side.
    const [stored, upstream] = await Promise.all([fromStore, fromUpstream]);
    if (upstream.ok) {
      blockingFetchCount += 1;
      return upstream.entry;
    }
    if (stored) return adoptFromStore(stored);
    // oxlint-disable-next-line executor/no-try-catch-or-throw -- boundary: nothing usable anywhere, so the upstream failure is the real answer
    throw upstream.error;
  };

  const ensureFresh = async (forceRefresh: boolean): Promise<CacheEntry> => {
    if (forceRefresh) return refreshBlocking();
    if (entry && isFresh(entry)) return entry;

    // Memory is stale but still usable: serve it now, revalidate behind it.
    if (entry && isUsable(entry)) {
      refreshInBackground();
      return entry;
    }

    // Cold isolate — store and upstream race; see `loadCold`.
    return loadCold();
  };

  const get: JWTVerifyGetKey = async (protectedHeader, token) => {
    const current = await ensureFresh(false);
    // oxlint-disable-next-line executor/no-try-catch-or-throw -- boundary: jose JWTVerifyGetKey retry path is defined by thrown resolver failures
    try {
      const resolveStartedAt = Date.now();
      const key = await current.resolver(protectedHeader, token);
      lastResolveMs = Date.now() - resolveStartedAt;
      return key;
    } catch (error) {
      // Likely cause: keys rotated upstream after our TTL window started, or
      // we answered from a stale entry. Refetch once and try again. Anything
      // still failing bubbles up so jose can classify it (we do not silently
      // swallow real failures).
      if (!isJwksNoMatchingKey(error)) {
        // oxlint-disable-next-line executor/no-try-catch-or-throw -- boundary: jose JWTVerifyGetKey requires preserving upstream resolver rejection
        throw error;
      }
      const refreshed = await ensureFresh(true);
      return refreshed.resolver(protectedHeader, token);
    }
  };

  const result = get as CachedRemoteJWKSet;
  Object.defineProperty(result, "forceRefresh", {
    value: () => {
      entry = null;
    },
  });
  Object.defineProperty(result, "inspect", {
    value: () => ({
      fetchedAt: entry?.fetchedAt ?? null,
      hasJwks: entry !== null,
      fetchCount,
      fetchFailureCount,
      blockingFetchCount,
      storeHitCount,
      lastFetchDurationMs,
      lastStoreReadMs,
      lastResolveMs,
    }),
  });
  return result;
};
