import { Effect, Exit } from "effect";
import { describe, expect, test } from "@effect/vitest";

import { Owner, ProviderItemId, type CredentialProvider, type PluginCtx } from "@executor-js/sdk";

import { decryptSecret, deriveKey, encryptSecret, encryptedSecretsPlugin } from "./index";

// ---------------------------------------------------------------------------
// In-memory PluginStorageFacade fake (owner-partitioned), enough to exercise
// the provider exactly as the executor's plugin-storage table would.
//
// v2: the provider keys values by the opaque `ProviderItemId` and uses the
// explicit connection scope for owner-partitioned reads and writes.
// ---------------------------------------------------------------------------

const makeFakeStorage = () => {
  const rows = new Map<string, { owner: Owner; key: string; collection: string; data: unknown }>();
  const composite = (collection: string, key: string) => `${collection} ${key}`;
  const toEntry = (row: { owner: Owner; key: string; collection: string; data: unknown }) => ({
    id: composite(row.collection, row.key),
    owner: row.owner,
    pluginId: "encryptedSecrets",
    collection: row.collection,
    key: row.key,
    data: row.data,
    createdAt: new Date(0),
    updatedAt: new Date(0),
  });
  const facade = {
    get: (input: { collection: string; key: string }) =>
      Effect.sync(() => {
        const row = rows.get(composite(input.collection, input.key));
        return row ? (toEntry(row) as never) : null;
      }),
    getForOwner: (input: { collection: string; key: string; owner: Owner }) =>
      Effect.sync(() => {
        const row = rows.get(composite(input.collection, input.key));
        return row && row.owner === input.owner ? (toEntry(row) as never) : null;
      }),
    list: (input: { collection: string }) =>
      Effect.sync(
        () =>
          [...rows.values()]
            .filter((row) => row.collection === input.collection)
            .map((row) => toEntry(row)) as never,
      ),
    put: (input: { collection: string; key: string; owner: Owner; data: unknown }) =>
      Effect.sync(() => {
        const row = {
          owner: input.owner,
          key: input.key,
          collection: input.collection,
          data: input.data,
        };
        rows.set(composite(input.collection, input.key), row);
        return toEntry(row) as never;
      }),
    remove: (input: { collection: string; key: string; owner: Owner }) =>
      Effect.sync(() => {
        rows.delete(composite(input.collection, input.key));
      }),
  };
  return { facade, rows };
};

const makeProvider = (key: string, owner: Owner = Owner.make("org")) => {
  const { facade, rows } = makeFakeStorage();
  // oxlint-disable-next-line executor/no-double-cast -- test boundary: minimal PluginCtx fake for the provider under test
  const ctx = {
    owner: { tenant: "tenant-a", subject: owner === Owner.make("user") ? "subject-a" : null },
    pluginStorage: facade,
  } as unknown as PluginCtx<unknown>;
  const plugin = encryptedSecretsPlugin({ key });
  const credentialProviders = plugin.credentialProviders as (
    ctx: PluginCtx<unknown>,
  ) => readonly CredentialProvider[];
  const provider = credentialProviders(ctx)[0]!;
  return { provider, rows };
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
    const { provider, rows } = makeProvider("master");
    await Effect.runPromise(provider.set!(id("github"), "ghp_plaintext"));
    const stored = String([...rows.values()][0]!.data);
    expect(stored).not.toContain("ghp_plaintext");
    expect(stored.startsWith("v1.")).toBe(true);
  });

  test("a user-bound executor stores and resolves an org connection secret in the org partition", async () => {
    const { provider, rows } = makeProvider("master", Owner.make("user"));
    const orgConnection = { owner: "org" as const, subject: "" };

    await Effect.runPromise(provider.set!(id("oauth:org:linear"), "token", orgConnection));

    expect([...rows.values()][0]!.owner).toBe("org");
    expect(
      await Effect.runPromise(provider.get(id("oauth:org:linear"), orgConnection)),
    ).toBe("token");
    // A different user-bound executor uses the same explicit org scope; its
    // caller subject is intentionally irrelevant to the provider lookup.
    expect(
      await Effect.runPromise(
        provider.get(id("oauth:org:linear"), { owner: "org", subject: "" }),
      ),
    ).toBe("token");
  });

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
