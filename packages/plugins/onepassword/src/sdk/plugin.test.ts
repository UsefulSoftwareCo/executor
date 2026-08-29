import { describe, it, expect } from "@effect/vitest";
import { Effect } from "effect";

import { ProviderKey, ToolAddress, createExecutor } from "@executor-js/sdk";
import { makeInMemoryBlobStore, pluginBlobStore } from "@executor-js/sdk/core";
import { makeTestConfig } from "@executor-js/sdk/testing";

import { makeOnePasswordStore, onepasswordPlugin, resolveConfiguredRef } from "./plugin";
import type { OnePasswordService } from "./service";
import { OnePasswordError } from "./errors";
import { OnePasswordConfig, DesktopAppAuth } from "./types";

// removed: v1 routed configure/removeConfig through an explicit `ScopeId`
// (`executor.onepassword.configure(config, ScopeId.make("test-scope"))`) and
// asserted provider registration via `executor.secrets.providers()`. v2 deletes
// the scope stack and the secrets table: config is a single owner-partitioned
// blob the extension derives from the executor's owner binding, and credential
// providers are discovered through `executor.providers.list()`.

const ONEPASSWORD = ProviderKey.make("onepassword");

const twoVaultConfig = OnePasswordConfig.make({
  auth: DesktopAppAuth.make({
    kind: "desktop-app",
    accountName: "my.1password.com",
  }),
  vaults: [
    { id: "vault-123", name: "Personal" },
    { id: "vault-456", name: "Work" },
  ],
  name: "1Password",
});

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

      yield* executor.onepassword.configure(twoVaultConfig);

      const loaded = yield* executor.onepassword.getConfig();
      expect(loaded?.vaults).toEqual([
        { id: "vault-123", name: "Personal" },
        { id: "vault-456", name: "Work" },
      ]);
      expect(loaded?.name).toBe("1Password");
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
          vaults: [{ id: "vault-123", name: "CI" }],
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
          vaults: [
            { id: "vault-123", name: "Personal" },
            { id: "vault-456", name: "Work" },
          ],
          name: "1Password",
        },
        { onElicitation: "accept-all" },
      );

      expect(configured).toEqual({ ok: true, data: { configured: true } });
      expect(
        yield* executor.execute(ToolAddress.make("executor.onepassword.getConfig"), {}),
      ).toMatchObject({
        ok: true,
        data: {
          config: {
            vaults: [
              { id: "vault-123", name: "Personal" },
              { id: "vault-456", name: "Work" },
            ],
            name: "1Password",
          },
        },
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

// ---------------------------------------------------------------------------
// Stored-config compatibility — blobs written before multi-vault support hold
// `{ auth, vaultId, name }`. Reads normalize that to a one-element vaults
// array; the next save writes the current shape.
// ---------------------------------------------------------------------------

describe("onepassword store", () => {
  const makeStore = () => {
    const blobs = pluginBlobStore(
      makeInMemoryBlobStore(),
      { org: "org_test", user: null },
      "onepassword",
    );
    return { blobs, store: makeOnePasswordStore(blobs) };
  };

  it.effect("upgrades a legacy single-vault blob on read", () =>
    Effect.gen(function* () {
      const { blobs, store } = makeStore();
      yield* blobs.put(
        "config",
        JSON.stringify({
          auth: { kind: "desktop-app", accountName: "my.1password.com" },
          vaultId: "vault-123",
          name: "Personal",
        }),
        { owner: "org" },
      );

      const config = yield* store.getConfig();
      expect(config).toEqual({
        auth: { kind: "desktop-app", accountName: "my.1password.com" },
        vaults: [{ id: "vault-123", name: "Personal" }],
        name: "Personal",
      });
    }),
  );

  it.effect("persists and reads back the multi-vault shape", () =>
    Effect.gen(function* () {
      const { store } = makeStore();
      yield* store.saveConfig(twoVaultConfig, "org");
      const config = yield* store.getConfig();
      expect(config).toEqual(twoVaultConfig);
    }),
  );
});

// ---------------------------------------------------------------------------
// Explicit ref resolution — vault-qualified refs resolve directly; bare refs
// must locate exactly one item, and a multi-vault match is an explicit
// ambiguity, never a precedence pick.
// ---------------------------------------------------------------------------

const fakeService = (
  itemsByVault: Readonly<Record<string, readonly { id: string; title: string }[]>>,
  onResolve?: (uri: string) => void,
): OnePasswordService => ({
  resolveSecret: (uri) => {
    onResolve?.(uri);
    return Effect.succeed(`secret:${uri}`);
  },
  listVaults: () => Effect.succeed(Object.keys(itemsByVault).map((id) => ({ id, title: id }))),
  listItems: (vaultId) => {
    const items = itemsByVault[vaultId];
    return items === undefined
      ? Effect.fail(new OnePasswordError({ operation: "item listing", message: "no such vault" }))
      : Effect.succeed(items);
  },
});

describe("resolveConfiguredRef", () => {
  it.effect("resolves a fully-qualified op:// URI in a configured vault as-is", () =>
    Effect.gen(function* () {
      const svc = fakeService({});
      const result = yield* resolveConfiguredRef(
        svc,
        twoVaultConfig,
        "op://vault-456/item-abc/password",
      );
      expect(result).toEqual({
        kind: "resolved",
        value: "secret:op://vault-456/item-abc/password",
      });
    }),
  );

  it.effect("appends the credential field to a picker-shaped op://vault/item ref", () =>
    Effect.gen(function* () {
      const svc = fakeService({});
      const result = yield* resolveConfiguredRef(svc, twoVaultConfig, "op://vault-123/item-abc");
      expect(result).toEqual({
        kind: "resolved",
        value: "secret:op://vault-123/item-abc/credential",
      });
    }),
  );

  it.effect("accepts an op:// URI addressed by vault name", () =>
    Effect.gen(function* () {
      const svc = fakeService({});
      const result = yield* resolveConfiguredRef(svc, twoVaultConfig, "op://Work/item/password");
      expect(result).toEqual({ kind: "resolved", value: "secret:op://Work/item/password" });
    }),
  );

  it.effect("reports an op:// URI outside the configured vaults", () =>
    Effect.gen(function* () {
      const svc = fakeService({});
      const result = yield* resolveConfiguredRef(
        svc,
        twoVaultConfig,
        "op://vault-999/item/password",
      );
      expect(result).toEqual({ kind: "outside-vaults" });
    }),
  );

  it.effect("resolves a bare ref that matches exactly one item across vaults", () =>
    Effect.gen(function* () {
      const svc = fakeService({
        "vault-123": [{ id: "item-1", title: "GitHub Token" }],
        "vault-456": [{ id: "item-2", title: "Stripe Key" }],
      });
      const result = yield* resolveConfiguredRef(svc, twoVaultConfig, "GitHub Token");
      expect(result).toEqual({
        kind: "resolved",
        value: "secret:op://vault-123/item-1/credential",
      });
    }),
  );

  it.effect("fails a bare ref that matches in two vaults with the vaults named", () =>
    Effect.gen(function* () {
      const svc = fakeService({
        "vault-123": [{ id: "item-1", title: "GitHub Token" }],
        "vault-456": [{ id: "item-2", title: "GitHub Token" }],
      });
      const result = yield* resolveConfiguredRef(svc, twoVaultConfig, "GitHub Token");
      expect(result).toEqual({
        kind: "ambiguous",
        matches: [
          {
            vaultId: "vault-123",
            vaultName: "Personal",
            itemId: "item-1",
            itemTitle: "GitHub Token",
          },
          { vaultId: "vault-456", vaultName: "Work", itemId: "item-2", itemTitle: "GitHub Token" },
        ],
      });
    }),
  );

  it.effect("treats duplicate titles inside one vault as ambiguous too", () =>
    Effect.gen(function* () {
      const svc = fakeService({
        "vault-123": [
          { id: "item-1", title: "GitHub Token" },
          { id: "item-9", title: "GitHub Token" },
        ],
        "vault-456": [],
      });
      const result = yield* resolveConfiguredRef(svc, twoVaultConfig, "GitHub Token");
      expect(result.kind).toBe("ambiguous");
    }),
  );

  it.effect("reports not-found for a bare ref matching nothing", () =>
    Effect.gen(function* () {
      const svc = fakeService({ "vault-123": [], "vault-456": [] });
      const result = yield* resolveConfiguredRef(svc, twoVaultConfig, "missing");
      expect(result).toEqual({ kind: "not-found" });
    }),
  );
});
