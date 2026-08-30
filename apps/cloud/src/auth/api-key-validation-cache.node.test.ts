import { describe, expect, it } from "@effect/vitest";
import { Effect, Exit, Layer } from "effect";

import {
  ApiKeyService,
  ApiKeyValidationError,
  makeCachedApiKeyValidate,
  type ApiKeyOwner,
} from "./api-keys";
import { WorkOSClient, type WorkOSClientService } from "./workos";

const stubWorkOS = (overrides: Partial<WorkOSClientService>) =>
  Layer.succeed(
    WorkOSClient,
    new Proxy({} as WorkOSClientService, {
      get: (_target, prop) => {
        if (prop in overrides) return overrides[prop as keyof WorkOSClientService];
        return () => Effect.die(`unexpected WorkOSClient.${String(prop)} call`);
      },
    }),
  );

const userOwner = (keyId: string): ApiKeyOwner => ({
  scope: "user",
  accountId: "user_123",
  organizationId: "org_123",
  keyId,
});

describe("makeCachedApiKeyValidate", () => {
  it.effect("serves a repeat validation from cache without a second upstream call", () =>
    Effect.gen(function* () {
      let calls = 0;
      const cached = makeCachedApiKeyValidate(() =>
        Effect.sync(() => {
          calls += 1;
          return userOwner("api_key_1");
        }),
      );

      const first = yield* cached.validate("sk_test_abc");
      const second = yield* cached.validate("sk_test_abc");

      expect(calls).toBe(1);
      expect(first).toEqual(userOwner("api_key_1"));
      expect(second).toEqual(first);
    }),
  );

  it.effect("re-validates once the TTL has expired", () =>
    Effect.gen(function* () {
      let calls = 0;
      let nowMs = 0;
      const cached = makeCachedApiKeyValidate(
        () =>
          Effect.sync(() => {
            calls += 1;
            return userOwner("api_key_1");
          }),
        { ttlMs: 1_000, now: () => nowMs },
      );

      yield* cached.validate("sk_test_abc");
      nowMs = 999;
      yield* cached.validate("sk_test_abc");
      expect(calls).toBe(1);

      nowMs = 1_000;
      yield* cached.validate("sk_test_abc");
      expect(calls).toBe(2);
    }),
  );

  it.effect("never caches an invalid key", () =>
    Effect.gen(function* () {
      let calls = 0;
      const cached = makeCachedApiKeyValidate(() =>
        Effect.sync(() => {
          calls += 1;
          return null;
        }),
      );

      const first = yield* cached.validate("sk_test_bad");
      const second = yield* cached.validate("sk_test_bad");

      expect(first).toBeNull();
      expect(second).toBeNull();
      expect(calls).toBe(2);
      expect(cached.cacheKeys()).toHaveLength(0);
    }),
  );

  it.effect("never caches an upstream failure", () =>
    Effect.gen(function* () {
      let calls = 0;
      const cached = makeCachedApiKeyValidate(() =>
        Effect.suspend(() => {
          calls += 1;
          return Effect.fail(new ApiKeyValidationError({ cause: "workos_down" }));
        }),
      );

      const first = yield* Effect.exit(cached.validate("sk_test_abc"));
      const second = yield* Effect.exit(cached.validate("sk_test_abc"));

      expect(Exit.isFailure(first)).toBe(true);
      expect(Exit.isFailure(second)).toBe(true);
      expect(calls).toBe(2);
      expect(cached.cacheKeys()).toHaveLength(0);
    }),
  );

  it.effect("resets a saturated map of live entries rather than growing past the bound", () =>
    Effect.gen(function* () {
      const cached = makeCachedApiKeyValidate((value) => Effect.succeed(userOwner(value)), {
        maxEntries: 3,
      });

      for (const value of ["sk_1", "sk_2", "sk_3"]) {
        yield* cached.validate(value);
      }
      expect(cached.cacheKeys()).toHaveLength(3);

      // Nothing is expired, so a fourth live entry resets the map instead of
      // growing it (mirrors execution-gate's writeCache).
      yield* cached.validate("sk_4");
      expect(cached.cacheKeys()).toHaveLength(1);

      yield* cached.validate("sk_5");
      expect(cached.cacheKeys()).toHaveLength(2);
    }),
  );

  it.effect("evicts expired entries before resetting a saturated map", () =>
    Effect.gen(function* () {
      let nowMs = 0;
      const cached = makeCachedApiKeyValidate((value) => Effect.succeed(userOwner(value)), {
        ttlMs: 1_000,
        maxEntries: 3,
        now: () => nowMs,
      });

      for (const value of ["sk_1", "sk_2", "sk_3"]) {
        yield* cached.validate(value);
      }
      expect(cached.cacheKeys()).toHaveLength(3);

      // Everything is expired: the sweep drops the stale entries and the new
      // one fits without a full reset.
      nowMs = 2_000;
      yield* cached.validate("sk_4");
      expect(cached.cacheKeys()).toHaveLength(1);
    }),
  );

  it.effect("keys the cache by the SHA-256 digest, never the raw key value", () =>
    Effect.gen(function* () {
      const rawKey = "sk_live_super_secret_value";
      const cached = makeCachedApiKeyValidate(() => Effect.succeed(userOwner("api_key_1")));

      yield* cached.validate(rawKey);

      const expectedDigest = yield* Effect.promise(async () => {
        const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(rawKey));
        return Array.from(new Uint8Array(digest), (byte) =>
          byte.toString(16).padStart(2, "0"),
        ).join("");
      });
      expect(cached.cacheKeys()).toEqual([expectedDigest]);
      expect(cached.cacheKeys()).not.toContain(rawKey);
    }),
  );
});

describe("ApiKeyService.WorkOS validation cache", () => {
  it.effect("validates a repeated key through one upstream call per layer build", () =>
    Effect.gen(function* () {
      let calls = 0;
      const layer = ApiKeyService.WorkOS.pipe(
        Layer.provide(
          stubWorkOS({
            validateApiKey: () =>
              Effect.sync(() => {
                calls += 1;
                return {
                  apiKey: {
                    id: "api_key_123",
                    owner: { type: "user", id: "user_123", organizationId: "org_123" },
                  },
                };
              }),
          }),
        ),
      );

      const { first, second } = yield* Effect.gen(function* () {
        const apiKeys = yield* ApiKeyService;
        return {
          first: yield* apiKeys.validate("sk_test_abc"),
          second: yield* apiKeys.validate("sk_test_abc"),
        };
      }).pipe(Effect.provide(layer));

      expect(calls).toBe(1);
      expect(first?.keyId).toBe("api_key_123");
      expect(second).toEqual(first);
    }),
  );
});
