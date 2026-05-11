import { describe, it, expect } from "@effect/vitest";
import { Effect } from "effect";
import {
  RemoveSecretInput,
  ScopeId,
  SecretId,
  SetSecretInput,
  createExecutor,
  makeTestConfig,
} from "@executor-js/sdk";
import { keychainPlugin } from "./index";

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

      const providers = yield* executor.secrets.providers();
      expect(providers.filter((provider) => provider === "keychain").length).toBeLessThanOrEqual(1);
    }),
  );

  // The tests below exercise the real system keychain.
  // They no-op when the platform package loads but no keychain service is reachable.

  it.effect.skipIf(!!process.env.CI)("stores and checks secret via system keychain", () =>
    Effect.gen(function* () {
      const testId = SecretId.make(`test-keychain-${Date.now()}`);
      const executor = yield* createExecutor(
        makeTestConfig({
          plugins: [keychainPlugin({ serviceName: "executor-test" })] as const,
        }),
      );
      const providers = yield* executor.secrets.providers();
      if (!providers.includes("keychain")) {
        return;
      }

      yield* Effect.gen(function* () {
        // Store through SDK, pinned to keychain provider
        yield* executor.secrets.set(
          new SetSecretInput({
            id: testId,
            scope: ScopeId.make("test-scope"),
            name: "Test Secret",
            value: "keychain-test-value",
            provider: "keychain",
          }),
        );

        // Plugin can check if it exists in the keychain
        const exists = yield* executor.keychain.has(testId);
        expect(exists).toBe(true);

        // SDK routes through the core secret table → pinned provider
        const resolved = yield* executor.secrets.get(testId);
        expect(resolved).toBe("keychain-test-value");
      }).pipe(
        Effect.ensuring(
          executor.secrets
            .remove(
              new RemoveSecretInput({
                id: testId,
                targetScope: ScopeId.make("test-scope"),
              }),
            )
            .pipe(Effect.orElseSucceed(() => undefined)),
        ),
      );
    }),
  );

  it.effect.skipIf(!!process.env.CI)("has returns false for missing secret", () =>
    Effect.gen(function* () {
      const executor = yield* createExecutor(
        makeTestConfig({
          plugins: [keychainPlugin({ serviceName: "executor-test" })] as const,
        }),
      );
      const providers = yield* executor.secrets.providers();
      if (!providers.includes("keychain")) {
        return;
      }

      const exists = yield* executor.keychain.has("nonexistent-secret");
      expect(exists).toBe(false);
    }),
  );
});
