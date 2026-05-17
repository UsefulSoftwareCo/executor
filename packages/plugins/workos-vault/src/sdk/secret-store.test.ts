import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";

/* oxlint-disable executor/no-try-catch-or-throw -- boundary: fake WorkOS Promise client throws SDK-like errors so wrapper behavior can be tested */

import {
  createExecutor,
  RemoveSecretInput,
  Scope,
  ScopeId,
  SecretId,
  SetSecretInput,
} from "@executor-js/sdk";
import { makeTestConfig, makeTestExecutor } from "@executor-js/sdk/testing";

import {
  WorkOSVaultClientError,
  type WorkOSVaultClient,
  type WorkOSVaultObject,
  type WorkOSVaultObjectMetadata,
} from "./client";
import { workosVaultPlugin } from "./plugin";

interface VaultMetadataRow {
  readonly id: string;
  readonly scope_id: string;
  readonly name: string;
  readonly purpose: string | null;
  readonly created_at: Date;
}

const toVaultMetadataRows = (rows: unknown): readonly VaultMetadataRow[] =>
  rows as readonly VaultMetadataRow[];

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
      catch: (cause) => new WorkOSVaultClientError({ cause, operation }),
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
      const current = [...objects.values()].find((o) => o.id === id);
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
        (_, version) => `v${Number(version) + 1}`,
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
      const entry = [...objects.entries()].find(([, o]) => o.id === id);
      if (!entry) throw new FakeNotFoundError(`Object "${id}" not found`);
      objects.delete(entry[0]);
    },
  };

  return {
    use: (operation, fn) =>
      Effect.tryPromise({
        try: () => fn(rawClient),
        catch: (cause) => new WorkOSVaultClientError({ cause, operation }),
      }),
    createObject: (opts) => wrap("create_object", () => rawClient.createObject(opts)),
    readObjectByName: (name) => wrap("read_object_by_name", () => rawClient.readObjectByName(name)),
    updateObject: (opts) => wrap("update_object", () => rawClient.updateObject(opts)),
    deleteObject: (opts) => wrap("delete_object", () => rawClient.deleteObject(opts)),
  };
};

const makeExecutor = (client: WorkOSVaultClient) =>
  makeTestExecutor({ plugins: [workosVaultPlugin({ client })] as const });

describe("WorkOS Vault secret provider", () => {
  it.effect("stores and resolves secrets through WorkOS Vault", () =>
    Effect.gen(function* () {
      const executor = yield* makeExecutor(makeFakeClient());

      yield* executor.secrets.set(
        SetSecretInput.make({
          id: SecretId.make("github-token"),
          scope: ScopeId.make("test-scope"),
          name: "GitHub Token",
          value: "ghp_secret",
        }),
      );

      expect(yield* executor.secrets.get("github-token")).toBe("ghp_secret");
      expect(executor.workosVault.providerKey).toBe("workos-vault");

      const listed = yield* executor.secrets.list();
      expect(listed).toHaveLength(1);
      expect(listed[0]!.name).toBe("GitHub Token");
      expect(listed[0]!.provider).toBe("workos-vault");
    }),
  );

  it.effect("updates metadata and secret values in place", () =>
    Effect.gen(function* () {
      const executor = yield* makeExecutor(makeFakeClient());

      yield* executor.secrets.set(
        SetSecretInput.make({
          id: SecretId.make("api-key"),
          scope: ScopeId.make("test-scope"),
          name: "Initial",
          value: "v1",
        }),
      );

      yield* executor.secrets.set(
        SetSecretInput.make({
          id: SecretId.make("api-key"),
          scope: ScopeId.make("test-scope"),
          name: "Updated",
          value: "v2",
        }),
      );

      expect(yield* executor.secrets.get("api-key")).toBe("v2");

      const listed = yield* executor.secrets.list();
      expect(listed).toHaveLength(1);
      expect(listed[0]!.name).toBe("Updated");
    }),
  );

  it.effect("removes secrets from Vault and metadata store", () =>
    Effect.gen(function* () {
      const executor = yield* makeExecutor(makeFakeClient());

      yield* executor.secrets.set(
        SetSecretInput.make({
          id: SecretId.make("remove-me"),
          scope: ScopeId.make("test-scope"),
          name: "Remove Me",
          value: "gone soon",
        }),
      );

      expect(yield* executor.secrets.get("remove-me")).toBe("gone soon");

      yield* executor.secrets.remove(
        RemoveSecretInput.make({
          id: SecretId.make("remove-me"),
          targetScope: ScopeId.make("test-scope"),
        }),
      );

      expect(yield* executor.secrets.get("remove-me")).toBeNull();
      expect(yield* executor.secrets.list()).toHaveLength(0);
    }),
  );

  it.effect("treats invalid Vault object names as missing during removal", () =>
    Effect.gen(function* () {
      const client = makeFakeClient({ rejectReadNamesLongerThan: 80 });
      const executor = yield* makeExecutor(client);
      const longSecretId = SecretId.make(
        "openapi-oauth-example-api-oauth2-user-org-user-01kp6xm1zpvqvtpj77f0yv4eax.access_token",
      );

      yield* executor.secrets.set(
        SetSecretInput.make({
          id: longSecretId,
          scope: ScopeId.make("test-scope"),
          name: "Long connection token",
          value: "token",
        }),
      );

      yield* executor.secrets.remove(
        RemoveSecretInput.make({
          id: longSecretId,
          targetScope: ScopeId.make("test-scope"),
        }),
      );

      expect(yield* executor.secrets.list()).toHaveLength(0);
    }),
  );

  it.effect("retries secret value writes on 409 version conflicts", () =>
    Effect.gen(function* () {
      const executor = yield* makeExecutor(makeFakeClient({ conflictOnNextSecretUpdate: true }));

      yield* executor.secrets.set(
        SetSecretInput.make({
          id: SecretId.make("conflict"),
          scope: ScopeId.make("test-scope"),
          name: "Conflict",
          value: "initial",
        }),
      );

      yield* executor.secrets.set(
        SetSecretInput.make({
          id: SecretId.make("conflict"),
          scope: ScopeId.make("test-scope"),
          name: "Conflict",
          value: "retry-me",
        }),
      );

      expect(yield* executor.secrets.get("conflict")).toBe("retry-me");

      const listed = yield* executor.secrets.list();
      expect(listed.map((s) => s.id)).toEqual(["conflict"]);
    }),
  );
});

const makeLayeredExecutors = (client: WorkOSVaultClient) =>
  Effect.gen(function* () {
    const plugins = [workosVaultPlugin({ client })] as const;

    const outerId = ScopeId.make("org");
    const innerId = ScopeId.make("user-org:u1:org");
    const outerScope = Scope.make({
      id: outerId,
      name: "outer",
      createdAt: new Date(),
    });
    const innerScope = Scope.make({
      id: innerId,
      name: "inner",
      createdAt: new Date(),
    });

    const config = makeTestConfig({ scopes: [innerScope, outerScope], plugins });
    const execOuter = yield* createExecutor({ ...config, scopes: [outerScope] });
    const execInner = yield* createExecutor({ ...config, scopes: [innerScope, outerScope] });
    return { execOuter, execInner, outerId, innerId, config };
  });

describe("WorkOS Vault secret provider — multi-scope isolation", () => {
  it.effect("encodes personal scope ids before using them in Vault object names", () =>
    Effect.gen(function* () {
      const client = makeFakeClient({ rejectNamesWithColon: true });
      const { execInner, innerId } = yield* makeLayeredExecutors(client);

      yield* execInner.secrets.set(
        SetSecretInput.make({
          id: SecretId.make("api-token"),
          scope: innerId,
          name: "Personal token",
          value: "personal",
        }),
      );

      expect(yield* execInner.secrets.get("api-token")).toBe("personal");
    }),
  );

  it.effect("secrets.remove at the inner scope does not wipe outer-scope metadata", () =>
    Effect.gen(function* () {
      const client = makeFakeClient();
      const { execOuter, execInner, outerId, innerId } = yield* makeLayeredExecutors(client);

      yield* execOuter.secrets.set(
        SetSecretInput.make({
          id: SecretId.make("api-token"),
          scope: outerId,
          name: "Org default",
          value: "org-default",
        }),
      );
      yield* execInner.secrets.set(
        SetSecretInput.make({
          id: SecretId.make("api-token"),
          scope: innerId,
          name: "Personal override",
          value: "personal-override",
        }),
      );

      yield* execInner.secrets.remove(
        RemoveSecretInput.make({
          id: SecretId.make("api-token"),
          targetScope: innerId,
        }),
      );

      const outer = yield* execOuter.secrets.list();
      expect(outer.map((r) => r.id)).toContain("api-token");
      expect(yield* execOuter.secrets.get("api-token")).toBe("org-default");
    }),
  );

  it.effect("shadowed `set` produces independent metadata rows per scope", () =>
    Effect.gen(function* () {
      const client = makeFakeClient();
      const { execOuter, execInner, outerId, innerId, config } =
        yield* makeLayeredExecutors(client);

      yield* execOuter.secrets.set(
        SetSecretInput.make({
          id: SecretId.make("api-token"),
          scope: outerId,
          name: "Org default",
          value: "org-default",
        }),
      );
      yield* execInner.secrets.set(
        SetSecretInput.make({
          id: SecretId.make("api-token"),
          scope: innerId,
          name: "Personal override",
          value: "personal-override",
        }),
      );

      const rows = toVaultMetadataRows(
        yield* Effect.promise(() =>
          config.db.findMany("workos_vault_metadata", {
            where: (b) => b("id", "=", "api-token"),
          }),
        ),
      );
      expect(rows).toHaveLength(2);
      const scopes = rows.map((r) => r.scope_id).sort();
      expect(scopes).toEqual([outerId, innerId].sort());
    }),
  );

  it.effect("list only includes metadata from the executor scope stack", () =>
    Effect.gen(function* () {
      const client = makeFakeClient();
      const plugins = [workosVaultPlugin({ client })] as const;
      const orgA = Scope.make({
        id: ScopeId.make("org_a"),
        name: "Org A",
        createdAt: new Date(),
      });
      const orgB = Scope.make({
        id: ScopeId.make("org_b"),
        name: "Org B",
        createdAt: new Date(),
      });
      const config = makeTestConfig({ scopes: [orgA], plugins });
      const execA = yield* createExecutor({ ...config, scopes: [orgA] });
      const execB = yield* createExecutor({ ...config, scopes: [orgB] });

      yield* execA.secrets.set(
        SetSecretInput.make({
          id: SecretId.make("api-token"),
          scope: orgA.id,
          name: "Org A token",
          value: "org-a-secret",
        }),
      );

      expect((yield* execA.secrets.list()).map((row) => row.id)).toContain("api-token");
      expect((yield* execB.secrets.list()).map((row) => row.id)).not.toContain("api-token");
    }),
  );

  it.effect("shadowed secrets resolve independently per scope", () =>
    Effect.gen(function* () {
      const client = makeFakeClient();
      const { execOuter, execInner, outerId, innerId } = yield* makeLayeredExecutors(client);

      yield* execOuter.secrets.set(
        SetSecretInput.make({
          id: SecretId.make("api-token"),
          scope: outerId,
          name: "Org default",
          value: "org-default",
        }),
      );
      yield* execInner.secrets.set(
        SetSecretInput.make({
          id: SecretId.make("api-token"),
          scope: innerId,
          name: "Personal override",
          value: "personal-override",
        }),
      );

      expect(yield* execInner.secrets.get("api-token")).toBe("personal-override");
      expect(yield* execOuter.secrets.get("api-token")).toBe("org-default");
    }),
  );
});

const makeExecutorForScope = (client: WorkOSVaultClient, scopeId: string) =>
  makeTestExecutor({
    plugins: [workosVaultPlugin({ client })] as const,
    scopes: [
      Scope.make({
        id: ScopeId.make(scopeId),
        name: scopeId,
        createdAt: new Date(),
      }),
    ],
  });

describe("WorkOS Vault secret provider — KEK context", () => {
  it.effect(
    "splits `user-org:<user>:<org>` scopes into `user_id` + `organization_id` context fields",
    () =>
      Effect.gen(function* () {
        const contexts: Record<string, string>[] = [];
        const fake = makeFakeClient();
        const recording: WorkOSVaultClient = {
          ...fake,
          createObject: (opts) => {
            contexts.push(opts.context);
            return fake.createObject(opts);
          },
        };
        const executor = yield* makeExecutorForScope(recording, "user-org:u1:org42");

        yield* executor.secrets.set(
          SetSecretInput.make({
            id: SecretId.make("api-token"),
            scope: ScopeId.make("user-org:u1:org42"),
            name: "Personal",
            value: "v",
          }),
        );

        expect(contexts).toHaveLength(1);
        expect(contexts[0]).toEqual({
          app: "executor",
          user_id: "u1",
          organization_id: "org42",
        });
      }),
  );

  it.effect("falls back to `{app, organization_id: scopeId}` for bare scope ids", () =>
    Effect.gen(function* () {
      const contexts: Record<string, string>[] = [];
      const fake = makeFakeClient();
      const recording: WorkOSVaultClient = {
        ...fake,
        createObject: (opts) => {
          contexts.push(opts.context);
          return fake.createObject(opts);
        },
      };
      const executor = yield* makeExecutorForScope(recording, "org42");

      yield* executor.secrets.set(
        SetSecretInput.make({
          id: SecretId.make("api-token"),
          scope: ScopeId.make("org42"),
          name: "Org default",
          value: "v",
        }),
      );

      expect(contexts[0]).toEqual({
        app: "executor",
        organization_id: "org42",
      });
    }),
  );
});
