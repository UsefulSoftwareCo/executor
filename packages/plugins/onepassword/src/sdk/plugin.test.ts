import { describe, it, expect } from "@effect/vitest";
import { Effect } from "effect";

import { ProviderKey, ToolAddress, createExecutor } from "@executor-js/sdk";
import { makeTestConfig } from "@executor-js/sdk/testing";

import { onepasswordPlugin } from "./plugin";
import { OnePasswordConfig, DesktopAppAuth } from "./types";

// removed: v1 routed configure/removeConfig through an explicit `ScopeId`
// (`executor.onepassword.configure(config, ScopeId.make("test-scope"))`) and
// asserted provider registration via `executor.secrets.providers()`. v2 deletes
// the scope stack and the secrets table: config is a single owner-partitioned
// blob the extension derives from the executor's owner binding, and credential
// providers are discovered through `executor.providers.list()`.

const ONEPASSWORD = ProviderKey.make("onepassword");

describe("onepassword plugin", () => {
  it.effect("registers onepassword as a credential provider", () =>
    Effect.gen(function* () {
      const executor = yield* createExecutor(
        makeTestConfig({ plugins: [onepasswordPlugin()] as const }),
      );
      const providers = yield* executor.providers.list();
      expect(providers).toContain(ONEPASSWORD);
    }),
  );

  it.effect("configure / getConfig / removeConfig round-trip via blob store", () =>
    Effect.gen(function* () {
      const executor = yield* createExecutor(
        makeTestConfig({ plugins: [onepasswordPlugin()] as const }),
      );

      const initial = yield* executor.onepassword.getConfig();
      expect(initial).toBeNull();

      const config = OnePasswordConfig.make({
        auth: DesktopAppAuth.make({
          kind: "desktop-app",
          accountName: "my.1password.com",
        }),
        vaultId: "vault-123",
        name: "Personal",
      });

      yield* executor.onepassword.configure(config);

      const loaded = yield* executor.onepassword.getConfig();
      expect(loaded?.vaultId).toBe("vault-123");
      expect(loaded?.name).toBe("Personal");
      expect(loaded?.auth.kind).toBe("desktop-app");

      yield* executor.onepassword.removeConfig();
      const afterRemove = yield* executor.onepassword.getConfig();
      expect(afterRemove).toBeNull();
    }),
  );

  it.effect("getConfig redacts the service-account token", () =>
    Effect.gen(function* () {
      const executor = yield* createExecutor(
        makeTestConfig({ plugins: [onepasswordPlugin()] as const }),
      );

      yield* executor.onepassword.configure(
        OnePasswordConfig.make({
          auth: { kind: "service-account", token: "super-secret-token" },
          vaultId: "vault-123",
          name: "CI",
        }),
      );

      const loaded = yield* executor.onepassword.getConfig();
      expect(loaded?.auth.kind).toBe("service-account");
      // The token must never be surfaced through the redacted projection.
      expect(JSON.stringify(loaded)).not.toContain("super-secret-token");
    }),
  );

  it.effect("exposes provider configuration as agent-callable static tools", () =>
    Effect.gen(function* () {
      const executor = yield* createExecutor(
        makeTestConfig({ plugins: [onepasswordPlugin()] as const }),
      );

      const configured = yield* executor.execute(
        ToolAddress.make("executor.onepassword.configure"),
        {
          auth: { kind: "desktop-app", accountName: "my.1password.com" },
          vaultId: "vault-123",
          name: "Personal",
        },
        { onElicitation: "accept-all" },
      );

      expect(configured).toEqual({ ok: true, data: { configured: true } });
      expect(
        yield* executor.execute(ToolAddress.make("executor.onepassword.getConfig"), {}),
      ).toMatchObject({
        ok: true,
        data: { config: { vaultId: "vault-123", name: "Personal" } },
      });

      const removed = yield* executor.execute(
        ToolAddress.make("executor.onepassword.removeConfig"),
        {},
        { onElicitation: "accept-all" },
      );

      expect(removed).toEqual({ ok: true, data: { removed: true } });
      expect(yield* executor.onepassword.getConfig()).toBeNull();
    }),
  );

  it.effect("status reports not-configured before configure", () =>
    Effect.gen(function* () {
      const executor = yield* createExecutor(
        makeTestConfig({ plugins: [onepasswordPlugin()] as const }),
      );
      const status = yield* executor.onepassword.status();
      expect(status.connected).toBe(false);
      expect(status.error).toBe("Not configured");
    }),
  );
});
