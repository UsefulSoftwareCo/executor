// ---------------------------------------------------------------------------
// In-memory JWKS cache for MCP JWT verification.
// ---------------------------------------------------------------------------
//
// Cloudflare Workers boot many short-lived isolates. `createRemoteJWKSet`'s
// default cooldown (30s) and cache max-age (10m) still results in many JWKS
// fetches per hour because each new isolate starts cold. Production p99 for
// `mcp.auth.jwt_verify` was 1.7s — almost entirely the JWKS fetch.
//
// This module offers a drop-in `createCachedRemoteJWKSet` that:
//
//   * Caches the JSON Web Key Set in module-scope memory for a configurable
//     TTL (default 1 hour).
//   * Single-flights concurrent fetches so a stampede of verifies during a
//     cache miss only fires one upstream request.
//   * Force-refreshes once when verification fails with a cached key, so
//     genuine key rotation isn't blocked by the TTL.
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

export interface CachedRemoteJWKSetOptions {
  /**
   * How long a successful fetch is considered fresh. Defaults to 1 hour —
   * AuthKit rotates JWKS roughly daily, and a forced refresh on verify
   * failure handles unscheduled rotations.
   */
  readonly ttlMs?: number;
  /** Override the fetch implementation for tests. */
  readonly fetch?: typeof globalThis.fetch;
  /** HTTP request timeout. Defaults to 5s, matching jose. */
  readonly timeoutMs?: number;
}

export interface CachedRemoteJWKSet extends JWTVerifyGetKey {
  /** Drop the cached JWKS so the next call refetches. */
  readonly forceRefresh: () => void;
  /** Inspect the current cache state (testing/diagnostics). */
  readonly inspect: () => { fetchedAt: number | null; hasJwks: boolean };
}

const DEFAULT_TTL_MS = 60 * 60 * 1000;
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

/**
 * Creates a cached, single-flight, force-refreshable JWKS resolver compatible
 * with `jose.jwtVerify`. Drop-in replacement for `createRemoteJWKSet` for the
 * MCP auth path — see module header for why we don't just use jose's built-in.
 */
export const createCachedRemoteJWKSet = (
  url: URL,
  options: CachedRemoteJWKSetOptions = {},
): CachedRemoteJWKSet => {
  const ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  // Capture the fetch impl lazily so consumers can swap globalThis.fetch
  // (tests do this) without us snapshotting a stale reference.
  const fetchImpl = (): typeof globalThis.fetch =>
    options.fetch ?? globalThis.fetch.bind(globalThis);

  let entry: CacheEntry | null = null;
  let inflight: Promise<CacheEntry> | null = null;

  const refresh = (): Promise<CacheEntry> => {
    if (inflight) return inflight;
    inflight = (async () => {
      const jwks = await fetchJwksOnce(url, fetchImpl(), timeoutMs);
      const next: CacheEntry = {
        jwks,
        fetchedAt: Date.now(),
        resolver: createLocalJWKSet(jwks),
      };
      entry = next;
      return next;
    })().finally(() => {
      inflight = null;
    });
    return inflight;
  };

  const ensureFresh = async (forceRefresh: boolean): Promise<CacheEntry> => {
    if (forceRefresh) return refresh();
    if (entry && Date.now() - entry.fetchedAt < ttlMs) return entry;
    return refresh();
  };

  const get: JWTVerifyGetKey = async (protectedHeader, token) => {
    const current = await ensureFresh(false);
    // oxlint-disable-next-line executor/no-try-catch-or-throw -- boundary: jose JWTVerifyGetKey retry path is defined by thrown resolver failures
    try {
      return await current.resolver(protectedHeader, token);
    } catch (error) {
      // Likely cause: keys rotated upstream after our TTL window started.
      // Refetch once and try again. Anything still failing bubbles up so
      // jose can classify it (we do not silently swallow real failures).
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
    }),
  });
  return result;
};
