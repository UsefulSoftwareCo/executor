import { Effect, Exit } from "effect";
import { describe, expect, test } from "@effect/vitest";

import { Owner, ProviderItemId, type CredentialProvider, type PluginCtx } from "@executor-js/sdk";

import { decryptSecret, deriveKey, encryptSecret, encryptedSecretsPlugin } from "./index";

// ---------------------------------------------------------------------------
// In-memory PluginStorageFacade fake that mirrors the executor's owner policy.
//
// The real plugin_storage table is owner-scoped: reads return rows matching
//   tenant = current AND (owner = 'org' OR (owner = 'user' AND subject = current))
// This fake accepts a `visibility` binding at construction time and replicates
// that predicate so tests can exercise cross-subject visibility.
//
// v2: the provider keys values by the opaque `ProviderItemId` (the storage
// `key`); writes carry an `owner` the host supplies. The connection row that
// references the id owns the (tenant, owner, subject) partition.
// ---------------------------------------------------------------------------

/** Row shape in the fake storage, including partition columns. */
interface FakeRow {
  readonly tenant: string;
  readonly owner: Owner;
  readonly subject: string;
  readonly key: string;
  readonly collection: string;
  readonly data: unknown;
}

/** The acting (tenant, subject) binding that gates reads, as in the real DB. */
interface FakeVisibility {
  readonly tenant: string;
  readonly subject: string | null;
}

/** Whether a stored row is visible under the given binding (mirrors onRead policy). */
const isVisible = (row: FakeRow, vis: FakeVisibility): boolean => {
  if (row.tenant !== vis.tenant) return false;
  if (row.owner === "org") return true;
  if (row.owner === "user" && vis.subject != null && row.subject === vis.subject) return true;
  return false;
};

/**
 * A single shared row store that multiple providers (with different
 * visibilities) can read/write — mirroring the real D1 table where all
 * subjects in one tenant share the same physical table.
 */
class SharedStore {
  readonly rows = new Map<string, FakeRow>();
  private readonly composite = (collection: string, key: string) => `${collection} ${key}`;

  /** Build a PluginStorageFacade view bound to a specific (tenant, subject). */
  view(vis: FakeVisibility) {
    const rows = this.rows;
    const composite = this.composite;
    const toEntry = (row: FakeRow) => ({
      id: composite(row.collection, row.key),
      owner: row.owner,
      pluginId: "encryptedSecrets",
      collection: row.collection,
      key: row.key,
      data: row.data,
      createdAt: new Date(0),
      updatedAt: new Date(0),
    });
    return {
      get: (input: { collection: string; key: string }) =>
        Effect.sync(() => {
          const row = rows.get(composite(input.collection, input.key));
          return row && isVisible(row, vis) ? (toEntry(row) as never) : null;
        }),
      getForOwner: (input: { collection: string; key: string; owner: Owner }) =>
        Effect.sync(() => {
          const row = rows.get(composite(input.collection, input.key));
          return row && row.owner === input.owner && isVisible(row, vis)
            ? (toEntry(row) as never)
            : null;
        }),
      list: (input: { collection: string }) =>
        Effect.sync(
          () =>
            [...rows.values()]
              .filter((row) => row.collection === input.collection && isVisible(row, vis))
              .map((row) => toEntry(row)) as never,
        ),
      put: (input: { collection: string; key: string; owner: Owner; data: unknown }) =>
        Effect.sync(() => {
          const subject = input.owner === "org" ? "" : (vis.subject ?? "");
          const row: FakeRow = {
            tenant: vis.tenant,
            owner: input.owner,
            subject,
            key: input.key,
            collection: input.collection,
            data: input.data,
          };
          rows.set(composite(input.collection, input.key), row);
          return toEntry(row) as never;
        }),
      remove: (input: { collection: string; key: string; owner: Owner }) =>
        Effect.sync(() => {
          const row = rows.get(composite(input.collection, input.key));
          if (row && isVisible(row, vis)) {
            rows.delete(composite(input.collection, input.key));
          }
        }),
    };
  }
}

/** Build a provider bound to a specific (tenant, subject), sharing one store. */
const makeProviderFromStore = (
  store: SharedStore,
  key: string,
  vis: FakeVisibility,
): { provider: CredentialProvider; store: SharedStore } => {
  const facade = store.view(vis);
  // oxlint-disable-next-line executor/no-double-cast -- test boundary: minimal PluginCtx fake for the provider under test
  const ctx = {
    owner: { tenant: vis.tenant, subject: vis.subject },
    pluginStorage: facade,
  } as unknown as PluginCtx<unknown>;
  const plugin = encryptedSecretsPlugin({ key });
  const credentialProviders = plugin.credentialProviders as (
    ctx: PluginCtx<unknown>,
  ) => readonly CredentialProvider[];
  const provider = credentialProviders(ctx)[0]!;
  return { provider, store };
};

/** Standalone provider+store for simple (non-cross-subject) tests. */
const makeProvider = (key: string, owner: Owner = Owner.make("org")) => {
  const vis: FakeVisibility = {
    tenant: "tenant-a",
    subject: owner === Owner.make("user") ? "subject-a" : null,
  };
  const store = new SharedStore();
  return makeProviderFromStore(store, key, vis);
};

const id = (value: string) => ProviderItemId.make(value);

const expectFailure = async <A, E>(effect: Effect.Effect<A, E>) => {
  const exit = await Effect.runPromiseExit(effect);
  expect(Exit.isFailure(exit)).toBe(true);
};

describe("crypto", () => {
  test("round-trips through encrypt/decrypt", async () => {
    const key = deriveKey("master-key-1");
    const payload = await Effect.runPromise(encryptSecret(key, "ghp_secret_value"));
    expect(payload.startsWith("v1.")).toBe(true);
    const back = await Effect.runPromise(decryptSecret(key, payload));
    expect(back).toBe("ghp_secret_value");
  });

  test("a different key cannot decrypt", async () => {
    const payload = await Effect.runPromise(encryptSecret(deriveKey("key-a"), "value"));
    await expectFailure(decryptSecret(deriveKey("key-b"), payload));
  });

  test("tampered ciphertext fails the auth tag", async () => {
    const key = deriveKey("master-key-1");
    const payload = await Effect.runPromise(encryptSecret(key, "value"));
    const parts = payload.split(".");
    const tampered = [
      parts[0],
      parts[1],
      parts[2],
      Buffer.from("tampered").toString("base64"),
    ].join(".");
    await expectFailure(decryptSecret(key, tampered));
  });
});

describe("provider", () => {
  test("set then get returns the plaintext", async () => {
    const { provider } = makeProvider("master");
    await Effect.runPromise(provider.set!(id("github"), "ghp_xyz"));
    const got = await Effect.runPromise(provider.get(id("github")));
    expect(got).toBe("ghp_xyz");
  });

  test("stores ciphertext at rest, not plaintext", async () => {
    const { provider, store } = makeProvider("master");
    await Effect.runPromise(provider.set!(id("github"), "ghp_plaintext"));
    const stored = String([...store.rows.values()][0]!.data);
    expect(stored).not.toContain("ghp_plaintext");
    expect(stored.startsWith("v1.")).toBe(true);
  });

  // removed: "a secret in one scope is invisible to another scope" — v2 drops
  // the scope arg entirely. The provider keys solely by the opaque
  // `ProviderItemId`; the referencing connection row owns the (tenant, owner,
  // subject) partition, so cross-scope isolation is no longer the provider's
  // concern to enforce or test.

  test("get returns null for a missing id", async () => {
    const { provider } = makeProvider("master");
    expect(await Effect.runPromise(provider.get(id("absent")))).toBeNull();
  });

  test("has and delete reflect presence", async () => {
    const { provider } = makeProvider("master");
    expect(await Effect.runPromise(provider.has!(id("k")))).toBe(false);
    await Effect.runPromise(provider.set!(id("k"), "v"));
    expect(await Effect.runPromise(provider.has!(id("k")))).toBe(true);
    await Effect.runPromise(provider.delete!(id("k")));
    expect(await Effect.runPromise(provider.has!(id("k")))).toBe(false);
    // delete is idempotent and returns void; deleting an absent id is a no-op.
    await Effect.runPromise(provider.delete!(id("k")));
    expect(await Effect.runPromise(provider.has!(id("k")))).toBe(false);
  });

  test("list surfaces stored ids", async () => {
    const { provider } = makeProvider("master");
    await Effect.runPromise(provider.set!(id("alpha"), "a"));
    await Effect.runPromise(provider.set!(id("beta"), "b"));
    const entries = await Effect.runPromise(provider.list!());
    expect(entries.map((e) => e.id).sort()).toEqual(["alpha", "beta"]);
  });
});

describe("cross-subject visibility (Service Token scenario)", () => {
  // In production, a human user authenticates in the browser and the OAuth
  // callback stores the access token via the encrypted provider. Later, an
  // MCP client authenticates with a Service Token (different subject within
  // the same tenant) and calls a tool that needs to retrieve that token.
  //
  // The token must be visible to both identities because the connection row
  // (which gates access) is org-owned. The provider must therefore store
  // tokens at the org partition, not at the individual subject's partition.

  test("a token stored by a human subject is visible to a Service Token subject", async () => {
    const store = new SharedStore();
    const tenant = "tenant-a";

    // Human user (browser OAuth) stores the token.
    const human = makeProviderFromStore(store, "master", { tenant, subject: "human@example.com" });
    await Effect.runPromise(human.provider.set!(id("oauth:org:gmail:default"), "ya29.token"));

    // Service Token (different subject) retrieves it.
    const svc = makeProviderFromStore(store, "master", {
      tenant,
      subject: "service-token-id.access",
    });
    const got = await Effect.runPromise(svc.provider.get(id("oauth:org:gmail:default")));
    expect(got).toBe("ya29.token");
  });
});
