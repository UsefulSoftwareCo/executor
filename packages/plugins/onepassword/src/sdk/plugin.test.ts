import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";

import { ScopeId, createExecutor, makeTestConfig } from "@executor-js/sdk";

import { onepasswordPlugin } from "./plugin";
import { OnePasswordConfig, DesktopAppAuth } from "./types";

describe("onepassword plugin", () => {
  it.effect("registers onepassword as a secret provider", () =>
    Effect.gen(function* () {
      const executor = yield* createExecutor(
        makeTestConfig({
          plugins: [onepasswordPlugin()] as const,
        }),
      );
      const providers = yield* executor.secrets.providers();
      expect(providers).toContain("onepassword");
    }),
  );

  it.effect("configure / getConfig / removeConfig round-trip via blob store", () =>
    Effect.gen(function* () {
      const executor = yield* createExecutor(
        makeTestConfig({
          plugins: [onepasswordPlugin()] as const,
        }),
      );

      const initial = yield* executor.onepassword.getConfig();
      expect(initial).toBeNull();

      const config = new OnePasswordConfig({
        auth: new DesktopAppAuth({
          kind: "desktop-app",
          accountName: "my.1password.com",
        }),
        vaultId: "vault-123",
        name: "Personal",
      });

      yield* executor.onepassword.configure(config, ScopeId.make("test-scope"));

      const loaded = yield* executor.onepassword.getConfig();
      expect(loaded?.vaultId).toBe("vault-123");
      expect(loaded?.name).toBe("Personal");
      expect(loaded?.auth.kind).toBe("desktop-app");

      yield* executor.onepassword.removeConfig(ScopeId.make("test-scope"));
      const afterRemove = yield* executor.onepassword.getConfig();
      expect(afterRemove).toBeNull();
    }),
  );

  it.effect("status reports not-configured before configure", () =>
    Effect.gen(function* () {
      const executor = yield* createExecutor(
        makeTestConfig({
          plugins: [onepasswordPlugin()] as const,
        }),
      );
      const status = yield* executor.onepassword.status();
      expect(status.connected).toBe(false);
      expect(status.error).toBe("Not configured");
    }),
  );
});
