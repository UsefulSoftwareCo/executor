// oxlint-disable executor/no-try-catch-or-throw -- boundary: the fake WorkOS Vault client below simulates the real promise SDK, which throws to signal API errors
import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";

import {
  Owner,
  type OwnerBinding,
  type PluginStorageEntry,
  ProviderItemId,
  type StorageDeps,
  Subject,
  Tenant,
} from "@executor-js/sdk/core";

import {
  type WorkOSVaultClient,
  WorkOSVaultClientError,
  type WorkOSVaultObject,
  type WorkOSVaultObjectMetadata,
  type WorkOSVaultPromiseApi,
} from "./client";
import { makeWorkOSVaultCredentialProvider, makeWorkosVaultStore } from "./secret-store";

// removed: the prior suite drove the provider through `executor.secrets.*`,
// `ScopeId`, `Scope`, and `SetSecretInput`/`RemoveSecretInput`. v2 deletes the
// secrets facade and the scope stack — the provider IS the credential backend
// and is exercised directly through its `CredentialProvider` surface, keyed by
// an opaque `ProviderItemId`. The multi-scope isolation and KEK-context suites
// are gone with it: the connection row now owns the (tenant, owner, subject)
// partition and the provider no longer derives a vault context from a scope id.

// ---------------------------------------------------------------------------
// Fake WorkOS Vault client — in-memory, mirrors the Effect-shaped surface of
// the real client. Errors carry a numeric `status` on `cause` so the
// production `isStatusError` checks in `secret-store.ts` match the same
// 404/409/400 paths the real SDK exercises.
// ---------------------------------------------------------------------------

class FakeNotFoundError extends Error {
  readonly status = 404;
}

class FakeConflictError extends Error {
  readonly status = 409;
}

class FakeInvalidRequestError extends Error {
  readonly status = 400;
}

const makeMetadata = (
  id: string,
  context: Record<string, string>,
  versionId: string = `${id}-v1`,
): WorkOSVaultObjectMetadata => ({
  id,
  context,
  updatedAt: new Date(),
  versionId,
});

const makeFakeClient = (options?: {
  readonly conflictOnNextSecretUpdate?: boolean;
  readonly rejectNamesWithColon?: boolean;
  readonly rejectReadNamesLongerThan?: number;
}): WorkOSVaultClient => {
  const objects = new Map<string, WorkOSVaultObject>();
  let sequence = 0;
  let conflictPending = options?.conflictOnNextSecretUpdate ?? false;

  const nextId = () => `obj_${(sequence += 1)}`;

  const wrap = <A>(
    operation: string,
    fn: () => Promise<A>,
  ): Effect.Effect<A, WorkOSVaultClientError, never> =>
    Effect.tryPromise({
      try: fn,
      catch: (cause: unknown) => new WorkOSVaultClientError({ cause, operation }),
    });

  const rawClient = {
    createObject: async ({
      name,
      value,
      context,
    }: {
      readonly name: string;
      readonly value: string;
      readonly context: Record<string, string>;
    }) => {
      if (options?.rejectNamesWithColon && name.includes(":")) {
        throw new FakeInvalidRequestError(`Invalid object name "${name}"`);
      }
      if (objects.has(name)) {
        throw new FakeConflictError(`Object "${name}" already exists`);
      }
      const id = nextId();
      const metadata = makeMetadata(id, context);
      objects.set(name, { id, name, value, metadata });
      return metadata;
    },

    readObjectByName: async (name: string) => {
      if (options?.rejectNamesWithColon && name.includes(":")) {
        throw new FakeInvalidRequestError(`Invalid object name "${name}"`);
      }
      if (
        options?.rejectReadNamesLongerThan !== undefined &&
        name.length > options.rejectReadNamesLongerThan
      ) {
        throw new FakeInvalidRequestError(`Invalid object name "${name}"`);
      }
      const object = objects.get(name);
      if (!object) throw new FakeNotFoundError(`Object "${name}" not found`);
      return object;
    },

    updateObject: async ({
      id,
      value,
      versionCheck,
    }: {
      readonly id: string;
      readonly value: string;
      readonly versionCheck?: string;
    }) => {
      const current = [...objects.values()].find((o: WorkOSVaultObject) => o.id === id);
      if (!current) throw new FakeNotFoundError(`Object "${id}" not found`);
      if (conflictPending && current.name.endsWith("/secrets/conflict")) {
        conflictPending = false;
        throw new FakeConflictError(`Injected conflict for "${id}"`);
      }
      if (versionCheck && current.metadata.versionId !== versionCheck) {
        throw new FakeConflictError(`Version mismatch for "${id}"`);
      }
      const nextVersion = current.metadata.versionId.replace(
        /v(\d+)$/,
        (_: string, version: string) => `v${Number(version) + 1}`,
      );
      const next: WorkOSVaultObject = {
        ...current,
        value,
        metadata: {
          ...current.metadata,
          updatedAt: new Date(),
          versionId: nextVersion,
        },
      };
      objects.set(current.name, next);
      return next;
    },

    deleteObject: async ({ id }: { readonly id: string }) => {
      const entry = [...objects.entries()].find(
        ([, o]: [string, WorkOSVaultObject]) => o.id === id,
      );
      if (!entry) throw new FakeNotFoundError(`Object "${id}" not found`);
      objects.delete(entry[0]);
    },
  };

  return {
    use: <A>(operation: string, fn: (client: WorkOSVaultPromiseApi) => Promise<A>) =>
      Effect.tryPromise({
        try: () => fn(rawClient),
        catch: (cause: unknown) => new WorkOSVaultClientError({ cause, operation }),
      }),
    createObject: (opts) => wrap("create_object", () => rawClient.createObject(opts)),
    readObjectByName: (name) => wrap("read_object_by_name", () => rawClient.readObjectByName(name)),
    updateObject: (opts) => wrap("update_object", () => rawClient.updateObject(opts)),
    deleteObject: (opts) => wrap("delete_object", () => rawClient.deleteObject(opts)),
  };
};

// ---------------------------------------------------------------------------
// Fake plugin storage — owner-partitioned in-memory map, enough to back the
// metadata store. v2 writes carry an `owner`; reads/list are not owner-filtered.
// ---------------------------------------------------------------------------

const makeFakeStorageDeps = (binding: OwnerBinding): StorageDeps => {
  const rows = new Map<string, { owner: Owner; collection: string; key: string; data: unknown }>();
  const composite = (collection: string, key: string) => `${collection} ${key}`;
  const toEntry = (row: {
    owner: Owner;
    collection: string;
    key: string;
    data: unknown;
  }): PluginStorageEntry => ({
    id: composite(row.collection, row.key),
    owner: row.owner,
    pluginId: "workosVault",
    collection: row.collection,
    key: row.key,
    data: row.data,
    createdAt: new Date(0),
    updatedAt: new Date(0),
  });

  const pluginStorage = {
    collection: () =>
      expect.unreachable("collection() not used by the workos-vault metadata store"),
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
          collection: input.collection,
          key: input.key,
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

  return {
    owner: binding,
    // oxlint-disable-next-line executor/no-double-cast -- test boundary: blobs unused by the metadata store
    blobs: undefined as never,
    // oxlint-disable-next-line executor/no-double-cast -- test boundary: minimal PluginStorageFacade fake for the metadata store under test
    pluginStorage: pluginStorage as never,
  };
};

const orgBinding: OwnerBinding = { tenant: Tenant.make("tenant-a"), subject: null };

const makeProvider = (
  client: WorkOSVaultClient,
  binding: OwnerBinding = orgBinding,
): ReturnType<typeof makeWorkOSVaultCredentialProvider> => {
  const deps = makeFakeStorageDeps(binding);
  const store = makeWorkosVaultStore(deps);
  return makeWorkOSVaultCredentialProvider({ client, store, owner: binding });
};

const id = (value: string) => ProviderItemId.make(value);

describe("WorkOS Vault credential provider", () => {
  it.effect("stores and resolves values through WorkOS Vault", () =>
    Effect.gen(function* () {
      const provider = makeProvider(makeFakeClient());

      yield* provider.set!(id("github-token"), "ghp_secret");

      expect(yield* provider.get(id("github-token"))).toBe("ghp_secret");
      expect(provider.key).toBe("workos-vault");

      const listed = yield* provider.list!();
      expect(listed).toHaveLength(1);
      expect(listed[0]!.id).toBe("github-token");
    }),
  );

  it.effect("updates values in place", () =>
    Effect.gen(function* () {
      const provider = makeProvider(makeFakeClient());

      yield* provider.set!(id("api-key"), "v1");
      yield* provider.set!(id("api-key"), "v2");

      expect(yield* provider.get(id("api-key"))).toBe("v2");
      expect(yield* provider.list!()).toHaveLength(1);
    }),
  );

  it.effect("get returns null for an unknown id", () =>
    Effect.gen(function* () {
      const provider = makeProvider(makeFakeClient());
      expect(yield* provider.get(id("absent"))).toBeNull();
    }),
  );

  it.effect("has reflects presence", () =>
    Effect.gen(function* () {
      const provider = makeProvider(makeFakeClient());
      expect(yield* provider.has!(id("k"))).toBe(false);
      yield* provider.set!(id("k"), "v");
      expect(yield* provider.has!(id("k"))).toBe(true);
    }),
  );

  it.effect("removes values from Vault and the metadata store", () =>
    Effect.gen(function* () {
      const provider = makeProvider(makeFakeClient());

      yield* provider.set!(id("remove-me"), "gone soon");
      expect(yield* provider.get(id("remove-me"))).toBe("gone soon");

      yield* provider.delete!(id("remove-me"));

      expect(yield* provider.get(id("remove-me"))).toBeNull();
      expect(yield* provider.list!()).toHaveLength(0);

      // delete is idempotent and returns void; deleting an absent id is a no-op.
      yield* provider.delete!(id("remove-me"));
      expect(yield* provider.has!(id("remove-me"))).toBe(false);
    }),
  );

  it.effect("treats invalid Vault object names as missing on read", () =>
    Effect.gen(function* () {
      // A read for a name longer than the cap returns 400; the provider must
      // treat that as "no value" rather than failing.
      const provider = makeProvider(makeFakeClient({ rejectReadNamesLongerThan: 40 }));
      const longId = id(
        "openapi-oauth-example-api-oauth2-user-org-user-01kp6xm1zpvqvtpj77f0yv4eax.access_token",
      );

      yield* provider.set!(longId, "token");
      // The metadata row exists; the vault value read is treated as missing.
      expect(yield* provider.get(longId)).toBeNull();

      yield* provider.delete!(longId);
      expect(yield* provider.list!()).toHaveLength(0);
    }),
  );

  it.effect("retries value writes on 409 version conflicts", () =>
    Effect.gen(function* () {
      const provider = makeProvider(makeFakeClient({ conflictOnNextSecretUpdate: true }));

      yield* provider.set!(id("conflict"), "initial");
      yield* provider.set!(id("conflict"), "retry-me");

      expect(yield* provider.get(id("conflict"))).toBe("retry-me");
      expect((yield* provider.list!()).map((s) => s.id)).toEqual(["conflict"]);
    }),
  );

  it.effect("encodes ids with colons before using them in Vault object names", () =>
    Effect.gen(function* () {
      // The object name URL-encodes the id segment, so a colon-bearing id never
      // reaches the vault as a raw `:` (which the fake rejects with a 400).
      const provider = makeProvider(makeFakeClient({ rejectNamesWithColon: true }));

      yield* provider.set!(id("user-org:u1:org42"), "personal");
      expect(yield* provider.get(id("user-org:u1:org42"))).toBe("personal");
    }),
  );

  it.effect("an id without an embedded owner falls back to the caller binding", () =>
    Effect.gen(function* () {
      const userBinding: OwnerBinding = {
        tenant: Tenant.make("tenant-a"),
        subject: Subject.make("subject-a"),
      };
      const provider = makeProvider(makeFakeClient(), userBinding);

      yield* provider.set!(id("token"), "v");
      expect(yield* provider.get(id("token"))).toBe("v");
    }),
  );
});

// ---------------------------------------------------------------------------
// Owner partitioning: a credential's metadata is filed under the CREDENTIAL's
// owner (embedded in the item id), not the acting caller's binding — so an
// org-shared credential resolves for every member of the org, and a personal
// one stays private to its subject. This fake models the real cross-owner
// visibility (`org` ∪ the caller's own `user` partition) the flat fake above
// does not.
// ---------------------------------------------------------------------------

const makePartitionedBacking = () => {
  type Row = {
    readonly owner: Owner;
    readonly subject: string;
    readonly collection: string;
    readonly key: string;
    readonly data: unknown;
  };
  const rows = new Map<string, Row>();
  const partKey = (owner: string, subject: string, collection: string, key: string) =>
    `${owner} ${subject} ${collection} ${key}`;
  const subjectFor = (owner: Owner, binding: OwnerBinding) =>
    owner === "org" ? "" : String(binding.subject ?? "");
  const toEntry = (row: Row): PluginStorageEntry => ({
    id: `${row.collection} ${row.key}`,
    owner: row.owner,
    pluginId: "workosVault",
    collection: row.collection,
    key: row.key,
    data: row.data,
    createdAt: new Date(0),
    updatedAt: new Date(0),
  });

  const depsFor = (binding: OwnerBinding): StorageDeps => {
    // Mirrors `ownerVisibilityCondition`: a pure-org caller sees only org rows;
    // a bound subject sees its own user rows plus org rows (user first).
    const visibleOwners: readonly Owner[] =
      binding.subject == null ? [Owner.make("org")] : [Owner.make("user"), Owner.make("org")];
    const findVisible = (collection: string, key: string): Row | null => {
      for (const owner of visibleOwners) {
        const row = rows.get(partKey(owner, subjectFor(owner, binding), collection, key));
        if (row) return row;
      }
      return null;
    };
    const pluginStorage = {
      collection: () => expect.unreachable("collection() not used by the metadata store"),
      get: (input: { collection: string; key: string }) =>
        Effect.sync(() => {
          const row = findVisible(input.collection, input.key);
          return row ? (toEntry(row) as never) : null;
        }),
      getForOwner: (input: { collection: string; key: string; owner: Owner }) =>
        Effect.sync(() => {
          const row = rows.get(
            partKey(input.owner, subjectFor(input.owner, binding), input.collection, input.key),
          );
          return row ? (toEntry(row) as never) : null;
        }),
      list: (input: { collection: string }) =>
        Effect.sync(
          () =>
            [...rows.values()]
              .filter((row) => row.collection === input.collection)
              .map(toEntry) as never,
        ),
      put: (input: { collection: string; key: string; owner: Owner; data: unknown }) =>
        Effect.sync(() => {
          const subject = subjectFor(input.owner, binding);
          const row: Row = {
            owner: input.owner,
            subject,
            collection: input.collection,
            key: input.key,
            data: input.data,
          };
          rows.set(partKey(input.owner, subject, input.collection, input.key), row);
          return toEntry(row) as never;
        }),
      remove: (input: { collection: string; key: string; owner: Owner }) =>
        Effect.sync(() => {
          rows.delete(
            partKey(input.owner, subjectFor(input.owner, binding), input.collection, input.key),
          );
        }),
    };
    return {
      owner: binding,
      // oxlint-disable-next-line executor/no-double-cast -- test boundary: blobs unused
      blobs: undefined as never,
      // oxlint-disable-next-line executor/no-double-cast -- test boundary: partition-aware fake
      pluginStorage: pluginStorage as never,
    };
  };
  return { depsFor };
};

const userBinding = (subject: string): OwnerBinding => ({
  tenant: Tenant.make("tenant-a"),
  subject: Subject.make(subject),
});

describe("WorkOS Vault — credential owner partitioning", () => {
  it.effect("a workspace connection created by one member resolves for another", () =>
    Effect.gen(function* () {
      const backing = makePartitionedBacking();
      const client = makeFakeClient(); // shared vault — the value object is org-wide
      const creator = makeWorkOSVaultCredentialProvider({
        client,
        store: makeWorkosVaultStore(backing.depsFor(userBinding("subject-a"))),
        owner: userBinding("subject-a"),
      });
      const other = makeWorkOSVaultCredentialProvider({
        client,
        store: makeWorkosVaultStore(backing.depsFor(userBinding("subject-b"))),
        owner: userBinding("subject-b"),
      });

      // user A pastes the org connection's API key
      yield* creator.set!(id("connection:org:exa_search_api:workspaceexa:token"), "exa_secret");

      // user B (same org, different subject) resolves the same org connection
      expect(yield* other.get(id("connection:org:exa_search_api:workspaceexa:token"))).toBe(
        "exa_secret",
      );
      // …and an automation context with no subject resolves it too
      const automation = makeWorkOSVaultCredentialProvider({
        client,
        store: makeWorkosVaultStore(
          backing.depsFor({ tenant: Tenant.make("tenant-a"), subject: null }),
        ),
        owner: { tenant: Tenant.make("tenant-a"), subject: null },
      });
      expect(yield* automation.get(id("connection:org:exa_search_api:workspaceexa:token"))).toBe(
        "exa_secret",
      );
    }),
  );

  it.effect("a personal connection stays private to its owner", () =>
    Effect.gen(function* () {
      const backing = makePartitionedBacking();
      const client = makeFakeClient();
      const userA = makeWorkOSVaultCredentialProvider({
        client,
        store: makeWorkosVaultStore(backing.depsFor(userBinding("subject-a"))),
        owner: userBinding("subject-a"),
      });
      const userB = makeWorkOSVaultCredentialProvider({
        client,
        store: makeWorkosVaultStore(backing.depsFor(userBinding("subject-b"))),
        owner: userBinding("subject-b"),
      });

      yield* userA.set!(id("connection:user:notion:personal:token"), "private_secret");

      // user A resolves their own; user B cannot see the metadata → no value
      expect(yield* userA.get(id("connection:user:notion:personal:token"))).toBe("private_secret");
      expect(yield* userB.get(id("connection:user:notion:personal:token"))).toBeNull();
    }),
  );

  it.effect("oauth and oauth-client ids are partitioned by their embedded owner", () =>
    Effect.gen(function* () {
      const backing = makePartitionedBacking();
      const client = makeFakeClient();
      const creator = makeWorkOSVaultCredentialProvider({
        client,
        store: makeWorkosVaultStore(backing.depsFor(userBinding("subject-a"))),
        owner: userBinding("subject-a"),
      });
      const other = makeWorkOSVaultCredentialProvider({
        client,
        store: makeWorkosVaultStore(backing.depsFor(userBinding("subject-b"))),
        owner: userBinding("subject-b"),
      });

      yield* creator.set!(id("oauth:org:slack:workspace"), "access_tok");
      yield* creator.set!(id("oauth-client:org:my_app:secret"), "client_sec");

      expect(yield* other.get(id("oauth:org:slack:workspace"))).toBe("access_tok");
      expect(yield* other.get(id("oauth-client:org:my_app:secret"))).toBe("client_sec");
    }),
  );
});

// ---------------------------------------------------------------------------
// Object-name partition isolation. A logical item id
// (connection:/oauth:/oauth-client:) carries no tenant and no subject, so two
// parties that pick the same integration + connection name produce a
// byte-identical id. The vault object keyspace is GLOBAL (one WorkOS
// environment), so the object name must encode the partition for two parties'
// objects to stay distinct. These tests use ONE shared fake client (the global
// keyspace) with per-party metadata stores (each party's own DB partition), and
// assert each party reads back its OWN secret — i.e. identical ids in different
// partitions never resolve to the same object.
// ---------------------------------------------------------------------------

const orgBindingFor = (tenant: string): OwnerBinding => ({
  tenant: Tenant.make(tenant),
  subject: null,
});

describe("WorkOS Vault — object-name partition isolation", () => {
  it.effect("the same org item id in two tenants does not share a vault object", () =>
    Effect.gen(function* () {
      const client = makeFakeClient(); // one global vault keyspace
      const tenantOne = makeProvider(client, orgBindingFor("org-1"));
      const tenantTwo = makeProvider(client, orgBindingFor("org-2"));

      // Both orgs connect the same integration under the same default name, so
      // the logical item id is identical across tenants.
      const sharedId = id("connection:org:websets:workspacewebsets:token");
      yield* tenantOne.set!(sharedId, "org-1-key");
      yield* tenantTwo.set!(sharedId, "org-2-key");

      expect(yield* tenantOne.get(sharedId)).toBe("org-1-key");
      expect(yield* tenantTwo.get(sharedId)).toBe("org-2-key");
    }),
  );

  it.effect("the same personal item id for two users does not share a vault object", () =>
    Effect.gen(function* () {
      const client = makeFakeClient();
      const userA = makeProvider(client, userBinding("subject-a"));
      const userB = makeProvider(client, userBinding("subject-b"));

      const sharedId = id("connection:user:dealcloud:personaldealcloud:token");
      yield* userA.set!(sharedId, "a-token");
      yield* userB.set!(sharedId, "b-token");

      expect(yield* userA.get(sharedId)).toBe("a-token");
      expect(yield* userB.get(sharedId)).toBe("b-token");
    }),
  );

  // WorkOS Vault accepts createObject names of ANY length, but an object whose
  // name exceeds 200 characters is permanently unreadable — every read 400s,
  // by name AND by id (verified against the live vault 2026-06-10: 200 reads
  // fine, 201 never does). createObject succeeding says nothing about the name
  // being usable. Ids whose scoped name would exceed the limit swap the
  // encoded tail for a sha256 digest; the fake mirrors the real API (creates
  // always succeed, reads reject names over 200), so an over-long generated
  // name fails this roundtrip instead of silently surfacing
  // `connection_value_missing` in prod.
  it.effect("a long item id roundtrips through a capped (hashed-tail) object name", () =>
    Effect.gen(function* () {
      const client = makeFakeClient({ rejectReadNamesLongerThan: 200 });
      const longId = id(
        "oauth:user:microsoft_graph_v1_0_sharepoint_files_excel_outlook_combined_curated:" +
          "personalmicrosoftgraphv10sharepointfilesexceloutlookcombinedcurated:refresh",
      );
      const siblingId = id(
        "oauth:user:microsoft_graph_v1_0_sharepoint_files_excel_outlook_combined_curated:" +
          "personalmicrosoftgraphv10sharepointfilesexceloutlookcombinedcurated",
      );

      const userA = makeProvider(client, {
        tenant: Tenant.make("org_01KP6XMWC2WGC2960Y63FGP7BM"),
        subject: Subject.make("user_01KP6XM1ZPVQVTPJ77F0YV4EAX"),
      });
      const userB = makeProvider(client, {
        tenant: Tenant.make("org_01KP6XMWC2WGC2960Y63FGP7BM"),
        subject: Subject.make("user_01KP6XRGC9ZF41ZZF5CXWVCPCC"),
      });

      yield* userA.set!(longId, "a-refresh-token");
      yield* userA.set!(siblingId, "a-access-token");
      yield* userB.set!(longId, "b-refresh-token");

      // resolves (name under the limit), hashed siblings stay distinct, and
      // identical long ids in two partitions stay isolated
      expect(yield* userA.get(longId)).toBe("a-refresh-token");
      expect(yield* userA.get(siblingId)).toBe("a-access-token");
      expect(yield* userB.get(longId)).toBe("b-refresh-token");

      // a second write lands on the same capped name (update, not duplicate)
      yield* userA.set!(longId, "a-refresh-token-2");
      expect(yield* userA.get(longId)).toBe("a-refresh-token-2");
    }),
  );
});
