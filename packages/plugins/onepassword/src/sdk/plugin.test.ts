import { expect, layer } from "@effect/vitest";
import { Effect } from "effect";

import { ScopeId, createExecutor } from "@executor-js/sdk";
import { makeTestWorkspaceLayer, TestWorkspace } from "@executor-js/sdk/testing";

import { onepasswordPlugin } from "./plugin";
import { OnePasswordConfig, DesktopAppAuth } from "./types";

const plugins = [onepasswordPlugin()] as const;

layer(
  makeTestWorkspaceLayer({
    plugins,
  }),
  { timeout: "15 seconds" },
)("onepassword plugin", (it) => {
  it.effect("registers onepassword as a secret provider", () =>
    Effect.gen(function* () {
      const { config: harnessConfig } = yield* TestWorkspace;
      const executor = yield* createExecutor({ ...harnessConfig, plugins });
      const providers = yield* executor.secrets.providers();
      expect(providers).toContain("onepassword");
    }),
  );

  it.effect("configure / getConfig / removeConfig round-trip via blob store", () =>
    Effect.gen(function* () {
      const { config: harnessConfig } = yield* TestWorkspace;
      const executor = yield* createExecutor({ ...harnessConfig, plugins });

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
      const { config: harnessConfig } = yield* TestWorkspace;
      const executor = yield* createExecutor({ ...harnessConfig, plugins });
      const status = yield* executor.onepassword.status();
      expect(status.connected).toBe(false);
      expect(status.error).toBe("Not configured");
    }),
  );
});
