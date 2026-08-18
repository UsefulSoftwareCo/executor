import { describe, expect, it } from "@effect/vitest";
import {
  SignJWT,
  exportJWK,
  generateKeyPair,
  jwtVerify,
  type JSONWebKeySet,
  type JWK,
  type KeyLike,
} from "jose";

import { createCachedRemoteJWKSet, type JwksStore, type StoredJwks } from "./jwks-cache";

const issuer = "https://test-authkit.example.com";
const audience = "client_test_fixture";
const jwksUrl = new URL("https://test-authkit.example.com/oauth2/jwks");

interface Keypair {
  readonly kid: string;
  readonly publicJwk: JWK;
  readonly privateKey: KeyLike;
}

const generateRotatableKeypair = async (kid: string): Promise<Keypair> => {
  const { publicKey, privateKey } = await generateKeyPair("RS256");
  const jwk = await exportJWK(publicKey);
  return { kid, publicJwk: { ...jwk, kid, alg: "RS256" }, privateKey };
};

const sign = (keypair: Keypair) =>
  new SignJWT({})
    .setProtectedHeader({ alg: "RS256", kid: keypair.kid })
    .setIssuer(issuer)
    .setSubject("user_test")
    .setAudience(audience)
    .setIssuedAt()
    .setExpirationTime("5m")
    .sign(keypair.privateKey);

interface FetchHarness {
  readonly fetch: typeof globalThis.fetch;
  readonly callCount: () => number;
  readonly setKeys: (keys: ReadonlyArray<JWK>) => void;
}

const makeFetchHarness = (initialKeys: ReadonlyArray<JWK>): FetchHarness => {
  let keys: ReadonlyArray<JWK> = initialKeys;
  let calls = 0;

  const fetch: typeof globalThis.fetch = async () => {
    calls++;
    const body: JSONWebKeySet = { keys: keys.map((k) => ({ ...k })) };
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };

  return {
    fetch,
    callCount: () => calls,
    setKeys: (next) => {
      keys = next;
    },
  };
};

interface StoreHarness extends JwksStore {
  readonly seed: (stored: StoredJwks) => void;
  readonly reads: () => number;
  readonly writes: () => number;
}

/** Stands in for the Workers Cache API: shared across "isolates", in memory. */
const makeStoreHarness = (): StoreHarness => {
  const entries = new Map<string, StoredJwks>();
  let reads = 0;
  let writes = 0;
  return {
    get: async (url) => {
      reads++;
      return entries.get(url.toString()) ?? null;
    },
    put: async (url, stored) => {
      writes++;
      entries.set(url.toString(), stored);
    },
    seed: (stored) => {
      entries.set(jwksUrl.toString(), stored);
    },
    reads: () => reads,
    writes: () => writes,
  };
};

/** A fetch that always fails, standing in for a slow/down key server. */
const failingFetch: typeof globalThis.fetch = async () => {
  // oxlint-disable-next-line executor/no-try-catch-or-throw, executor/no-error-constructor -- test double: `fetch` signals an unreachable key server by rejecting
  throw new Error("JWKS endpoint unreachable");
};

describe("createCachedRemoteJWKSet", () => {
  it("FAILING-WITHOUT-CACHE: N verifications hit JWKS endpoint only once within TTL", async () => {
    const kp = await generateRotatableKeypair("k1");
    const harness = makeFetchHarness([kp.publicJwk]);
    const jwks = createCachedRemoteJWKSet(jwksUrl, { fetch: harness.fetch });

    for (let i = 0; i < 5; i++) {
      const token = await sign(kp);
      const { payload } = await jwtVerify(token, jwks, { issuer, audience });
      expect(payload.sub).toBe("user_test");
    }

    expect(harness.callCount()).toBe(1);
  });

  it("single-flights concurrent cache misses into one fetch", async () => {
    const kp = await generateRotatableKeypair("k1");

    let resolveFetch!: () => void;
    const gate = new Promise<void>((r) => {
      resolveFetch = r;
    });

    let calls = 0;
    const fetch: typeof globalThis.fetch = async () => {
      calls++;
      await gate;
      const body: JSONWebKeySet = { keys: [{ ...kp.publicJwk }] };
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };

    const jwks = createCachedRemoteJWKSet(jwksUrl, { fetch });
    const token = await sign(kp);

    const verifies = Array.from({ length: 10 }, () => jwtVerify(token, jwks, { issuer, audience }));
    // Let microtasks settle so all 10 calls hit the cache miss path.
    await new Promise((r) => setTimeout(r, 10));
    resolveFetch();
    const results = await Promise.all(verifies);
    expect(results).toHaveLength(10);
    expect(calls).toBe(1);
  });

  it("forces a refresh when verification fails with a no-matching-key error (key rotation)", async () => {
    const oldKey = await generateRotatableKeypair("k_old");
    const newKey = await generateRotatableKeypair("k_new");

    const harness = makeFetchHarness([oldKey.publicJwk]);
    const jwks = createCachedRemoteJWKSet(jwksUrl, { fetch: harness.fetch });

    // Warm the cache with the old key.
    const t1 = await sign(oldKey);
    const ok = await jwtVerify(t1, jwks, { issuer, audience });
    expect(ok.payload.sub).toBe("user_test");
    expect(harness.callCount()).toBe(1);

    // Upstream rotates: only the new key remains in the JWKS endpoint.
    harness.setKeys([newKey.publicJwk]);

    // A token signed with the new key must verify even though our cache
    // still has the old one — the resolver must refetch on miss.
    const t2 = await sign(newKey);
    const ok2 = await jwtVerify(t2, jwks, { issuer, audience });
    expect(ok2.payload.sub).toBe("user_test");
    expect(harness.callCount()).toBe(2);
  });

  it("re-fetches after the TTL window elapses", async () => {
    const kp = await generateRotatableKeypair("k1");
    const harness = makeFetchHarness([kp.publicJwk]);
    const jwks = createCachedRemoteJWKSet(jwksUrl, {
      fetch: harness.fetch,
      ttlMs: 10,
    });

    const t1 = await sign(kp);
    await jwtVerify(t1, jwks, { issuer, audience });
    expect(harness.callCount()).toBe(1);

    await new Promise((r) => setTimeout(r, 20));

    const t2 = await sign(kp);
    await jwtVerify(t2, jwks, { issuer, audience });
    expect(harness.callCount()).toBe(2);
  });

  it("forceRefresh() invalidates the cache so the next call refetches", async () => {
    const kp = await generateRotatableKeypair("k1");
    const harness = makeFetchHarness([kp.publicJwk]);
    const jwks = createCachedRemoteJWKSet(jwksUrl, { fetch: harness.fetch });

    const t1 = await sign(kp);
    await jwtVerify(t1, jwks, { issuer, audience });
    expect(harness.callCount()).toBe(1);

    jwks.forceRefresh();

    await jwtVerify(t1, jwks, { issuer, audience });
    expect(harness.callCount()).toBe(2);
  });

  // -------------------------------------------------------------------------
  // Cross-isolate store — the cold-isolate path that caused the 2026-08-18
  // 500s: no module-scope entry, so every verify paid an upstream fetch.
  // -------------------------------------------------------------------------

  it("a cold isolate serves from the store instead of going upstream", async () => {
    const kp = await generateRotatableKeypair("k1");
    const store = makeStoreHarness();

    // First isolate: cold everywhere, so it fetches and populates the store.
    const warm = makeFetchHarness([kp.publicJwk]);
    const first = createCachedRemoteJWKSet(jwksUrl, { fetch: warm.fetch, store });
    const t1 = await sign(kp);
    await jwtVerify(t1, first, { issuer, audience });
    expect(warm.callCount()).toBe(1);
    expect(store.writes()).toBe(1);

    // A brand-new isolate (fresh module scope). If it reaches upstream at all
    // the fetch fails, so verifying proves the store answered.
    const second = createCachedRemoteJWKSet(jwksUrl, { fetch: failingFetch, store });
    const { payload } = await jwtVerify(t1, second, { issuer, audience });
    expect(payload.sub).toBe("user_test");
    expect(store.reads()).toBeGreaterThan(0);
  });

  it("keeps serving the last good keys when the key server is down", async () => {
    const kp = await generateRotatableKeypair("k1");
    const harness = makeFetchHarness([kp.publicJwk]);
    let upstreamUp = true;
    const flaky: typeof globalThis.fetch = (...args) =>
      upstreamUp ? harness.fetch(...args) : failingFetch(...args);

    // ttl short enough that the next call is past it, stale window generous.
    const jwks = createCachedRemoteJWKSet(jwksUrl, {
      fetch: flaky,
      store: null,
      ttlMs: 10,
      staleMaxMs: 60_000,
    });

    const token = await sign(kp);
    await jwtVerify(token, jwks, { issuer, audience });

    upstreamUp = false;
    await new Promise((r) => setTimeout(r, 20));

    // Past the TTL with a dead upstream: the cached keys still verify.
    const { payload } = await jwtVerify(token, jwks, { issuer, audience });
    expect(payload.sub).toBe("user_test");
  });

  it("stops serving stale keys once the stale window closes", async () => {
    const kp = await generateRotatableKeypair("k1");
    const harness = makeFetchHarness([kp.publicJwk]);
    let upstreamUp = true;
    const flaky: typeof globalThis.fetch = (...args) =>
      upstreamUp ? harness.fetch(...args) : failingFetch(...args);

    const jwks = createCachedRemoteJWKSet(jwksUrl, {
      fetch: flaky,
      store: null,
      ttlMs: 5,
      staleMaxMs: 10,
    });

    const token = await sign(kp);
    await jwtVerify(token, jwks, { issuer, audience });

    upstreamUp = false;
    await new Promise((r) => setTimeout(r, 30));

    // Beyond staleMaxMs the keys are no longer trustworthy — fail, don't
    // silently honour a key set we can no longer confirm.
    await expect(jwtVerify(token, jwks, { issuer, audience })).rejects.toThrow();
  });

  it("attributes background revalidation to fetchCount but not blockingFetchCount", async () => {
    const kp = await generateRotatableKeypair("k1");
    const harness = makeFetchHarness([kp.publicJwk]);
    const jwks = createCachedRemoteJWKSet(jwksUrl, {
      fetch: harness.fetch,
      store: null,
      ttlMs: 10,
      staleMaxMs: 60_000,
    });

    const token = await sign(kp);
    await jwtVerify(token, jwks, { issuer, audience });
    expect(jwks.inspect().blockingFetchCount).toBe(1);

    await new Promise((r) => setTimeout(r, 20));

    // Past the TTL: served from the stale entry, revalidated behind it. The
    // caller waited on nothing, so latency must not be attributed to it.
    const before = jwks.inspect();
    await jwtVerify(token, jwks, { issuer, audience });
    const after = jwks.inspect();

    expect(after.blockingFetchCount).toBe(before.blockingFetchCount);
    expect(after.fetchCount).toBeGreaterThan(before.fetchCount);
  });

  it("records a cold-isolate store read as a store hit, not a fetch", async () => {
    const kp = await generateRotatableKeypair("k1");
    const store = makeStoreHarness();
    const warm = makeFetchHarness([kp.publicJwk]);

    const first = createCachedRemoteJWKSet(jwksUrl, { fetch: warm.fetch, store });
    const token = await sign(kp);
    await jwtVerify(token, first, { issuer, audience });

    const second = createCachedRemoteJWKSet(jwksUrl, { fetch: failingFetch, store });
    await jwtVerify(token, second, { issuer, audience });

    const stats = second.inspect();
    expect(stats.storeHitCount).toBe(1);
    expect(stats.blockingFetchCount).toBe(0);
  });

  it("does not block a request on revalidation once keys are cached", async () => {
    const kp = await generateRotatableKeypair("k1");
    const harness = makeFetchHarness([kp.publicJwk]);
    let hang = false;
    const slowAfterFirst: typeof globalThis.fetch = async (...args) => {
      if (hang) await new Promise((r) => setTimeout(r, 5_000));
      return harness.fetch(...args);
    };

    const jwks = createCachedRemoteJWKSet(jwksUrl, {
      fetch: slowAfterFirst,
      store: null,
      ttlMs: 10,
      staleMaxMs: 60_000,
    });

    const token = await sign(kp);
    await jwtVerify(token, jwks, { issuer, audience });

    hang = true;
    await new Promise((r) => setTimeout(r, 20));

    // The revalidation behind this call hangs for 5s; the verify must not.
    const startedAt = Date.now();
    await jwtVerify(token, jwks, { issuer, audience });
    expect(Date.now() - startedAt).toBeLessThan(1_000);
  });
});
