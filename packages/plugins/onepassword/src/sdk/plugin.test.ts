import { describe, it, expect } from "@effect/vitest";
import { Effect } from "effect";

import { ProviderKey, ToolAddress, createExecutor } from "@executor-js/sdk";
import { makeInMemoryBlobStore, pluginBlobStore } from "@executor-js/sdk/core";
import { makeTestConfig } from "@executor-js/sdk/testing";

import { makeOnePasswordStore, onepasswordPlugin, resolveConfiguredRef } from "./plugin";
import type { OnePasswordService } from "./service";
import { OnePasswordError } from "./errors";
import { OnePasswordAccount, OnePasswordConfig, DesktopAppAuth } from "./types";

// removed: v1 routed configure/removeConfig through an explicit `ScopeId`
// (`executor.onepassword.configure(config, ScopeId.make("test-scope"))`) and
// asserted provider registration via `executor.secrets.providers()`. v2 deletes
// the scope stack and the secrets table: config is a single owner-partitioned
// blob the extension derives from the executor's owner binding, and credential
// providers are discovered through `executor.providers.list()`.

const ONEPASSWORD = ProviderKey.make("onepassword");

const desktopAuth = DesktopAppAuth.make({
  kind: "desktop-app",
  accountName: "my.1password.com",
});

const twoVaultAccount = OnePasswordAccount.make({
  id: "acct-default",
  name: "1Password",
  auth: desktopAuth,
  vaults: [
    { id: "vault-123", name: "Personal" },
    { id: "vault-456", name: "Work" },
  ],
});

const oneAccountConfig = OnePasswordConfig.make({ accounts: [twoVaultAccount] });

const twoAccountConfig = OnePasswordConfig.make({
  accounts: [
    OnePasswordAccount.make({
      id: "acct-work",
      name: "Work",
      auth: desktopAuth,
      vaults: [{ id: "vault-eng", name: "Engineering" }],
    }),
    OnePasswordAccount.make({
      id: "acct-personal",
      name: "Personal",
      auth: DesktopAppAuth.make({ kind: "desktop-app", accountName: "family.1password.com" }),
      vaults: [{ id: "vault-home", name: "Home" }],
    }),
  ],
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

  it.effect("configure upserts accounts by id and removeConfig removes them one by one", () =>
    Effect.gen(function* () {
      const executor = yield* createExecutor(
        makeTestConfig({ plugins: [onepasswordPlugin()] as const }),
      );

      const initial = yield* executor.onepassword.getConfig();
      expect(initial).toBeNull();

      const first = yield* executor.onepassword.configure({
        name: "Work",
        auth: desktopAuth,
        vaults: [{ id: "vault-eng", name: "Engineering" }],
      });
      const second = yield* executor.onepassword.configure({
        name: "Personal",
        auth: desktopAuth,
        vaults: [{ id: "vault-home", name: "Home" }],
      });
      expect(first.accountId).not.toBe(second.accountId);

      const loaded = yield* executor.onepassword.getConfig();
      expect(loaded?.accounts.map((account) => account.name).sort()).toEqual(["Personal", "Work"]);

      // Re-saving with an id replaces that account in place.
      yield* executor.onepassword.configure({
        id: first.accountId,
        name: "Work (renamed)",
        auth: desktopAuth,
        vaults: [
          { id: "vault-eng", name: "Engineering" },
          { id: "vault-infra", name: "Infra" },
        ],
      });
      const afterEdit = yield* executor.onepassword.getConfig();
      expect(afterEdit?.accounts.length).toBe(2);
      const edited = afterEdit?.accounts.find((account) => account.id === first.accountId);
      expect(edited?.name).toBe("Work (renamed)");
      expect(edited?.vaults.length).toBe(2);

      // Removing one account keeps the other.
      yield* executor.onepassword.removeConfig(first.accountId);
      const afterRemove = yield* executor.onepassword.getConfig();
      expect(afterRemove?.accounts.map((account) => account.id)).toEqual([second.accountId]);

      // Removing the last account deletes the config entirely.
      yield* executor.onepassword.removeConfig(second.accountId);
      expect(yield* executor.onepassword.getConfig()).toBeNull();
    }),
  );

  it.effect("removeConfig without an id removes everything", () =>
    Effect.gen(function* () {
      const executor = yield* createExecutor(
        makeTestConfig({ plugins: [onepasswordPlugin()] as const }),
      );
      yield* executor.onepassword.configure({
        name: "Work",
        auth: desktopAuth,
        vaults: [{ id: "vault-eng", name: "Engineering" }],
      });
      yield* executor.onepassword.configure({
        name: "Personal",
        auth: desktopAuth,
        vaults: [{ id: "vault-home", name: "Home" }],
      });
      yield* executor.onepassword.removeConfig();
      expect(yield* executor.onepassword.getConfig()).toBeNull();
    }),
  );

  it.effect("getConfig redacts every account's service-account token", () =>
    Effect.gen(function* () {
      const executor = yield* createExecutor(
        makeTestConfig({ plugins: [onepasswordPlugin()] as const }),
      );

      yield* executor.onepassword.configure({
        name: "CI",
        auth: { kind: "service-account", token: "super-secret-token" },
        vaults: [{ id: "vault-123", name: "CI" }],
      });
      yield* executor.onepassword.configure({
        name: "Deploys",
        auth: { kind: "service-account", token: "other-secret-token" },
        vaults: [{ id: "vault-456", name: "Deploys" }],
      });

      const loaded = yield* executor.onepassword.getConfig();
      expect(loaded?.accounts.every((account) => account.auth.kind === "service-account")).toBe(
        true,
      );
      // Tokens must never be surfaced through the redacted projection.
      expect(JSON.stringify(loaded)).not.toContain("super-secret-token");
      expect(JSON.stringify(loaded)).not.toContain("other-secret-token");
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
          name: "1Password",
          auth: { kind: "desktop-app", accountName: "my.1password.com" },
          vaults: [
            { id: "vault-123", name: "Personal" },
            { id: "vault-456", name: "Work" },
          ],
        },
        { onElicitation: "accept-all" },
      );

      expect(configured).toMatchObject({ ok: true, data: { configured: true } });
      const accountId = (configured as { data: { accountId: string } }).data.accountId;
      expect(typeof accountId).toBe("string");

      expect(
        yield* executor.execute(ToolAddress.make("executor.onepassword.getConfig"), {}),
      ).toMatchObject({
        ok: true,
        data: {
          config: {
            accounts: [
              {
                id: accountId,
                name: "1Password",
                vaults: [
                  { id: "vault-123", name: "Personal" },
                  { id: "vault-456", name: "Work" },
                ],
              },
            ],
          },
        },
      });

      const removed = yield* executor.execute(
        ToolAddress.make("executor.onepassword.removeConfig"),
        { accountId },
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
      expect(status.accounts).toEqual([]);
      expect(status.error).toBe("Not configured");
    }),
  );
});

// ---------------------------------------------------------------------------
// Stored-config compatibility — blobs written before multi-account support
// hold either `{ auth, vaultId, name }` (original) or `{ auth, vaults, name }`
// (multi-vault). Reads normalize both onto a single "default" account; the
// next save writes the current shape.
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
        accounts: [
          {
            id: "default",
            name: "Personal",
            auth: { kind: "desktop-app", accountName: "my.1password.com" },
            vaults: [{ id: "vault-123", name: "Personal" }],
          },
        ],
      });
    }),
  );

  it.effect("upgrades a single-account multi-vault blob on read", () =>
    Effect.gen(function* () {
      const { blobs, store } = makeStore();
      yield* blobs.put(
        "config",
        JSON.stringify({
          auth: { kind: "desktop-app", accountName: "my.1password.com" },
          vaults: [
            { id: "vault-123", name: "Personal" },
            { id: "vault-456", name: "Work" },
          ],
          name: "1Password",
        }),
        { owner: "org" },
      );

      const config = yield* store.getConfig();
      expect(config).toEqual({
        accounts: [
          {
            id: "default",
            name: "1Password",
            auth: { kind: "desktop-app", accountName: "my.1password.com" },
            vaults: [
              { id: "vault-123", name: "Personal" },
              { id: "vault-456", name: "Work" },
            ],
          },
        ],
      });
    }),
  );

  it.effect("persists and reads back the multi-account shape", () =>
    Effect.gen(function* () {
      const { store } = makeStore();
      yield* store.saveConfig(twoAccountConfig, "org");
      const config = yield* store.getConfig();
      expect(config).toEqual(twoAccountConfig);
    }),
  );
});

// ---------------------------------------------------------------------------
// Explicit ref resolution — vault-qualified refs resolve directly via the
// owning account; bare refs must locate exactly one item, and a multi-vault
// match is an explicit ambiguity, never a precedence pick.
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

/** One fake backend per account id; secrets resolve tagged with the serving
 *  account so tests can assert which account's auth handled a ref. */
const fakeServiceFor =
  (
    itemsByAccount: Readonly<
      Record<string, Readonly<Record<string, readonly { id: string; title: string }[]>>>
    >,
  ) =>
  (account: OnePasswordAccount) => {
    const items = itemsByAccount[account.id] ?? {};
    return Effect.succeed<OnePasswordService>({
      ...fakeService(items),
      resolveSecret: (uri) => Effect.succeed(`secret:${account.id}:${uri}`),
    });
  };

describe("resolveConfiguredRef", () => {
  const serviceFor = fakeServiceFor({});

  it.effect("resolves a fully-qualified op:// URI in a configured vault as-is", () =>
    Effect.gen(function* () {
      const result = yield* resolveConfiguredRef(
        oneAccountConfig,
        serviceFor,
        "op://vault-456/item-abc/password",
      );
      expect(result).toEqual({
        kind: "resolved",
        value: "secret:acct-default:op://vault-456/item-abc/password",
      });
    }),
  );

  it.effect("appends the credential field to a picker-shaped op://vault/item ref", () =>
    Effect.gen(function* () {
      const result = yield* resolveConfiguredRef(
        oneAccountConfig,
        serviceFor,
        "op://vault-123/item-abc",
      );
      expect(result).toEqual({
        kind: "resolved",
        value: "secret:acct-default:op://vault-123/item-abc/credential",
      });
    }),
  );

  it.effect("accepts an op:// URI addressed by vault name", () =>
    Effect.gen(function* () {
      const result = yield* resolveConfiguredRef(
        oneAccountConfig,
        serviceFor,
        "op://Work/item/password",
      );
      expect(result).toEqual({
        kind: "resolved",
        value: "secret:acct-default:op://Work/item/password",
      });
    }),
  );

  it.effect("routes a vault-qualified ref through the account that owns the vault", () =>
    Effect.gen(function* () {
      const result = yield* resolveConfiguredRef(
        twoAccountConfig,
        serviceFor,
        "op://vault-home/item-abc/password",
      );
      expect(result).toEqual({
        kind: "resolved",
        value: "secret:acct-personal:op://vault-home/item-abc/password",
      });
    }),
  );

  it.effect("reports a vault name configured in more than one account as ambiguous", () =>
    Effect.gen(function* () {
      const config = OnePasswordConfig.make({
        accounts: [
          OnePasswordAccount.make({
            id: "acct-a",
            name: "Work",
            auth: desktopAuth,
            vaults: [{ id: "vault-a", name: "Shared" }],
          }),
          OnePasswordAccount.make({
            id: "acct-b",
            name: "Personal",
            auth: desktopAuth,
            vaults: [{ id: "vault-b", name: "Shared" }],
          }),
        ],
      });
      const result = yield* resolveConfiguredRef(config, serviceFor, "op://Shared/item");
      expect(result).toEqual({
        kind: "ambiguous-vault",
        vaultName: "Shared",
        matches: [
          { accountName: "Work", vaultId: "vault-a" },
          { accountName: "Personal", vaultId: "vault-b" },
        ],
      });
    }),
  );

  it.effect("reports an op:// URI outside the configured vaults", () =>
    Effect.gen(function* () {
      const result = yield* resolveConfiguredRef(
        oneAccountConfig,
        serviceFor,
        "op://vault-999/item/password",
      );
      expect(result).toEqual({ kind: "outside-vaults" });
    }),
  );

  it.effect("resolves a bare ref that matches exactly one item across accounts", () =>
    Effect.gen(function* () {
      const withItems = fakeServiceFor({
        "acct-work": { "vault-eng": [{ id: "item-1", title: "GitHub Token" }] },
        "acct-personal": { "vault-home": [{ id: "item-2", title: "Stripe Key" }] },
      });
      const result = yield* resolveConfiguredRef(twoAccountConfig, withItems, "GitHub Token");
      expect(result).toEqual({
        kind: "resolved",
        value: "secret:acct-work:op://vault-eng/item-1/credential",
      });
    }),
  );

  it.effect("fails a bare ref that matches in two accounts with the matches named", () =>
    Effect.gen(function* () {
      const withItems = fakeServiceFor({
        "acct-work": { "vault-eng": [{ id: "item-1", title: "GitHub Token" }] },
        "acct-personal": { "vault-home": [{ id: "item-2", title: "GitHub Token" }] },
      });
      const result = yield* resolveConfiguredRef(twoAccountConfig, withItems, "GitHub Token");
      expect(result).toEqual({
        kind: "ambiguous",
        matches: [
          {
            accountName: "Work",
            vaultId: "vault-eng",
            vaultName: "Engineering",
            itemId: "item-1",
            itemTitle: "GitHub Token",
          },
          {
            accountName: "Personal",
            vaultId: "vault-home",
            vaultName: "Home",
            itemId: "item-2",
            itemTitle: "GitHub Token",
          },
        ],
      });
    }),
  );

  it.effect("treats duplicate titles inside one vault as ambiguous too", () =>
    Effect.gen(function* () {
      const withItems = fakeServiceFor({
        "acct-default": {
          "vault-123": [
            { id: "item-1", title: "GitHub Token" },
            { id: "item-9", title: "GitHub Token" },
          ],
          "vault-456": [],
        },
      });
      const result = yield* resolveConfiguredRef(oneAccountConfig, withItems, "GitHub Token");
      expect(result.kind).toBe("ambiguous");
    }),
  );

  it.effect("reports not-found for a bare ref matching nothing", () =>
    Effect.gen(function* () {
      const withItems = fakeServiceFor({
        "acct-default": { "vault-123": [], "vault-456": [] },
      });
      const result = yield* resolveConfiguredRef(oneAccountConfig, withItems, "missing");
      expect(result).toEqual({ kind: "not-found" });
    }),
  );
});
