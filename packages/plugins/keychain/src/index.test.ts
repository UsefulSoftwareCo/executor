import { describe, it, expect } from "@effect/vitest";
import { Effect } from "effect";
import { ProviderItemId, ProviderKey, createExecutor } from "@executor-js/sdk";
import { makeTestConfig } from "@executor-js/sdk/testing";
import { keychainPlugin } from "./index";
import { makeKeychainProvider } from "./provider";
import { setPassword, deletePassword } from "./keyring";

// removed: v1 tests routed through `executor.secrets.set/get/remove` with
// `ScopeId`/`SecretId`/`SetSecretInput`/`RemoveSecretInput` and a scope-derived
// keychain service name. v2 deletes the secrets table and scope partitioning —
// a connection IS the credential and the provider sees only an opaque
// ProviderItemId. The keychain-backed round-trip is now exercised directly
// against the CredentialProvider contract below; creating a connection through
// the executor requires a contributing integration plugin, which is out of
// scope for keychain's own unit tests.

const KEYCHAIN = ProviderKey.make("keychain");

// Detect whether the real system keychain is reachable (writes a sentinel and
// removes it). Mirrors the plugin's own registration probe.
const probeReachable = (serviceName: string): Effect.Effect<boolean> =>
  Effect.gen(function* () {
    const account = `__executor_keychain_test_probe__:${process.pid}:${Date.now()}`;
    return yield* setPassword(serviceName, account, "probe").pipe(
      Effect.andThen(deletePassword(serviceName, account).pipe(Effect.catch(() => Effect.void))),
      Effect.as(true),
      Effect.catch(() => Effect.succeed(false)),
    );
  });

describe("keychain plugin", () => {
  it.effect("exposes keychain metadata and registers a provider when reachable", () =>
    Effect.gen(function* () {
      const executor = yield* createExecutor(
        makeTestConfig({
          plugins: [keychainPlugin()] as const,
        }),
      );

      expect(executor.keychain.displayName).toBeTypeOf("string");
      expect(executor.keychain.isSupported).toBeTypeOf("boolean");

      const providers = yield* executor.providers.list();
      expect(providers.filter((provider) => provider === KEYCHAIN).length).toBeLessThanOrEqual(1);
    }),
  );

  // The tests below exercise the real system keychain.
  // They no-op when the platform package loads but no keychain service is reachable.

  it.effect.skipIf(!!process.env.CI)(
    "stores, checks, resolves, and deletes a value via system keychain",
    () =>
      Effect.gen(function* () {
        const serviceName = "executor-test";
        if (!(yield* probeReachable(serviceName))) {
          return;
        }

        const executor = yield* createExecutor(
          makeTestConfig({
            plugins: [keychainPlugin({ serviceName })] as const,
          }),
        );

        const provider = makeKeychainProvider(serviceName);
        const id = ProviderItemId.make(`test-keychain-${Date.now()}`);

        yield* Effect.gen(function* () {
          // Write through the provider (the v2 writable contract).
          yield* provider.set!(id, "keychain-test-value");

          // Plugin extension can check existence by opaque id.
          const exists = yield* executor.keychain.has(id);
          expect(exists).toBe(true);

          // Provider resolves the value back.
          const resolved = yield* provider.get(id);
          expect(resolved).toBe("keychain-test-value");
        }).pipe(Effect.ensuring(provider.delete!(id).pipe(Effect.orElseSucceed(() => undefined))));
      }),
  );

  it.effect.skipIf(!!process.env.CI)("has returns false for missing value", () =>
    Effect.gen(function* () {
      const executor = yield* createExecutor(
        makeTestConfig({
          plugins: [keychainPlugin({ serviceName: "executor-test" })] as const,
        }),
      );
      if (!(yield* probeReachable("executor-test"))) {
        return;
      }

      const exists = yield* executor.keychain.has("nonexistent-secret");
      expect(exists).toBe(false);
    }),
  );
});
