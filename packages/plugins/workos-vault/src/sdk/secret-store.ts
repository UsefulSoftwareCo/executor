import { Effect } from "effect";

import {
  dateColumn,
  type FumaRow,
  type FumaTables,
  nullableTextColumn,
  parseUserOrgScopeId,
  scopedExecutorTable,
  StorageError,
  type SecretProvider,
  type StorageDeps,
  type StorageFailure,
  textColumn,
} from "@executor-js/sdk/core";

import {
  type WorkOSVaultClient,
  type WorkOSVaultClientError,
  type WorkOSVaultObject,
} from "./client";

export const WORKOS_VAULT_PROVIDER_KEY = "workos-vault";

const DEFAULT_OBJECT_PREFIX = "executor";
const MAX_WRITE_ATTEMPTS = 3;
// WorkOS creates a per-context KEK just-in-time on first write; a create
// call immediately after that provisioning step can race with the KEK
// becoming usable and return a transient error whose message ends in
// "KEK was created but is not yet ready. This request can be retried."
// We back off and retry the whole attempt (read + create) a few times.
const MAX_KEK_NOT_READY_ATTEMPTS = 20;
const KEK_NOT_READY_BACKOFF_MS = 1000;

// ---------------------------------------------------------------------------
// Metadata schema — the plugin owns its own table for secret metadata
// (name, purpose, created_at). Values still live in WorkOS Vault; this
// table just tracks what we know about and lets us enumerate.
// ---------------------------------------------------------------------------

export const workosVaultSchema = {
  workos_vault_metadata: scopedExecutorTable("workos_vault_metadata", {
    name: textColumn("name"),
    purpose: nullableTextColumn("purpose"),
    created_at: dateColumn("created_at"),
  }),
} satisfies FumaTables;

export type WorkosVaultSchema = typeof workosVaultSchema;

type MetadataRow = FumaRow<WorkosVaultSchema["workos_vault_metadata"]>;

// ---------------------------------------------------------------------------
// WorkosVaultStore — typed metadata-store the plugin uses internally.
// ---------------------------------------------------------------------------

export interface WorkosVaultStore {
  readonly get: (id: string, scope: string) => Effect.Effect<MetadataRow | null, StorageFailure>;
  readonly upsert: (row: MetadataRow) => Effect.Effect<void, StorageFailure>;
  readonly remove: (id: string, scope: string) => Effect.Effect<boolean, StorageFailure>;
  readonly list: () => Effect.Effect<readonly MetadataRow[], StorageFailure>;
}

export const makeWorkosVaultStore = (deps: StorageDeps<WorkosVaultSchema>): WorkosVaultStore => {
  const { fuma } = deps;
  const scopeIds = deps.scopes.map((scope) => String(scope.id));

  // Every read/write to a specific row pins BOTH `id` and `scope_id`.
  // Scope is a normal FumaDB predicate here, not hidden behavior.
  const findScoped = (id: string, scope: string) =>
    fuma
      .use("workos_vault_metadata.findFirst", (db) =>
        db.findFirst("workos_vault_metadata", {
          where: (b) => b.and(b("id", "=", id), b("scope_id", "=", scope)),
        }),
      )
      .pipe(Effect.map((row): MetadataRow | null => row ?? null));

  return {
    get: (id, scope) => findScoped(id, scope),
    upsert: (row) =>
      Effect.gen(function* () {
        const existing = yield* findScoped(row.id, row.scope_id);
        if (existing) {
          yield* fuma.use("workos_vault_metadata.updateMany", (db) =>
            db.updateMany("workos_vault_metadata", {
              where: (b) => b.and(b("id", "=", row.id), b("scope_id", "=", row.scope_id)),
              set: {
                name: row.name,
                purpose: row.purpose ?? null,
              },
            }),
          );
          return;
        }
        yield* fuma
          .use("workos_vault_metadata.create", (db) =>
            db.create("workos_vault_metadata", {
              id: row.id,
              scope_id: row.scope_id,
              name: row.name,
              purpose: row.purpose ?? null,
              created_at: row.created_at,
            }),
          )
          .pipe(Effect.asVoid);
      }),
    remove: (id, scope) =>
      Effect.gen(function* () {
        const existing = yield* findScoped(id, scope);
        if (!existing) return false;
        yield* fuma.use("workos_vault_metadata.deleteMany", (db) =>
          db.deleteMany("workos_vault_metadata", {
            where: (b) => b.and(b("id", "=", id), b("scope_id", "=", scope)),
          }),
        );
        return true;
      }),
    list: () =>
      fuma
        .use("workos_vault_metadata.findMany", (db) =>
          db.findMany("workos_vault_metadata", {
            where: (b) =>
              scopeIds.length === 1
                ? b("scope_id", "=", scopeIds[0]!)
                : b("scope_id", "in", [...scopeIds]),
          }),
        )
        .pipe(
          Effect.map((rows): readonly MetadataRow[] =>
            [...rows].sort((l, r) => l.created_at.getTime() - r.created_at.getTime()),
          ),
        ),
  };
};

// ---------------------------------------------------------------------------
// Vault helpers — scope-prefixed object naming + 409-retry upsert.
// ---------------------------------------------------------------------------

const isStatusError = (error: WorkOSVaultClientError, status: number): boolean =>
  error.status === status;

const isKekNotReadyError = (error: WorkOSVaultClientError): boolean =>
  error.retryKind === "kek_not_ready";

// Default context builder. Each semantic piece of a scope id lives in
// its own vault-context key so WorkOS's KEK matcher sees individual
// dimensions (org, user) rather than a single opaque compound string.
// Splitting also sidesteps the "KEK was created but is not yet ready"
// hang we hit when a context value contained `:` — per-field values are
// colon-free by construction.
//
// Cloud's scope ids are either:
//   - `user-org:<userId>:<orgId>`  → per-user-within-org scope
//   - `<orgId>`                    → bare org scope
//
// Callers with other scope shapes can override via
// `WorkOSVaultSecretProviderOptions.contextForScope`.
export type WorkOSVaultContextForScope = (scopeId: string) => Record<string, string>;

export const defaultWorkOSVaultContextForScope: WorkOSVaultContextForScope = (scopeId) => {
  // Parser is single-sourced in `@executor-js/sdk` alongside the producer
  // (`userOrgScopeId` / `makeUserOrgScopeStack`), so the id shape the host apps
  // emit and the shape we split here cannot drift.
  const parsed = parseUserOrgScopeId(scopeId);
  const base: Record<string, string> = {
    app: "executor",
    organization_id: parsed ? parsed.organizationId : scopeId,
  };
  if (parsed) base.user_id = parsed.userId;
  return base;
};

const encodeObjectNameSegment = (segment: string): string => encodeURIComponent(segment);

const secretObjectName = (prefix: string, scopeId: string, secretId: string): string =>
  `${prefix}/${encodeObjectNameSegment(scopeId)}/secrets/${encodeObjectNameSegment(secretId)}`;

const legacySecretObjectName = (prefix: string, scopeId: string, secretId: string): string =>
  `${prefix}/${scopeId}/secrets/${secretId}`;

const loadSecretObject = (
  client: WorkOSVaultClient,
  prefix: string,
  scopeId: string,
  secretId: string,
): Effect.Effect<WorkOSVaultObject | null, WorkOSVaultClientError, never> =>
  client.readObjectByName(secretObjectName(prefix, scopeId, secretId)).pipe(
    Effect.catch((error: WorkOSVaultClientError) => {
      if (isStatusError(error, 400)) return Effect.succeed(null);
      if (!isStatusError(error, 404)) return Effect.fail(error);

      const encodedName = secretObjectName(prefix, scopeId, secretId);
      const legacyName = legacySecretObjectName(prefix, scopeId, secretId);
      if (legacyName === encodedName) return Effect.succeed(null);

      return client
        .readObjectByName(legacyName)
        .pipe(
          Effect.catch((legacyError: WorkOSVaultClientError) =>
            isStatusError(legacyError, 404) || isStatusError(legacyError, 400)
              ? Effect.succeed(null)
              : Effect.fail(legacyError),
          ),
        );
    }),
  );

const upsertSecretValue = (
  client: WorkOSVaultClient,
  prefix: string,
  scopeId: string,
  secretId: string,
  value: string,
  contextForScope: WorkOSVaultContextForScope,
): Effect.Effect<void, WorkOSVaultClientError, never> => {
  const attemptWrite = (
    remainingConflictAttempts: number,
    remainingKekAttempts: number,
  ): Effect.Effect<void, WorkOSVaultClientError, never> =>
    Effect.gen(function* () {
      const existing = yield* loadSecretObject(client, prefix, scopeId, secretId);

      if (existing) {
        yield* client.updateObject({
          id: existing.id,
          value,
          versionCheck: existing.metadata.versionId,
        });
        return;
      }

      yield* client.createObject({
        name: secretObjectName(prefix, scopeId, secretId),
        value,
        context: contextForScope(scopeId),
      });
    }).pipe(
      Effect.catch((error: WorkOSVaultClientError) => {
        if (remainingConflictAttempts > 1 && isStatusError(error, 409)) {
          return attemptWrite(remainingConflictAttempts - 1, remainingKekAttempts);
        }
        if (remainingKekAttempts > 1 && isKekNotReadyError(error)) {
          console.warn(
            `[workos-vault] KEK not ready for scope=${scopeId} secret=${secretId} — ` +
              `retrying in ${KEK_NOT_READY_BACKOFF_MS}ms ` +
              `(${MAX_KEK_NOT_READY_ATTEMPTS - remainingKekAttempts + 1}/${MAX_KEK_NOT_READY_ATTEMPTS})`,
          );
          return Effect.sleep(KEK_NOT_READY_BACKOFF_MS).pipe(
            Effect.flatMap(() => attemptWrite(remainingConflictAttempts, remainingKekAttempts - 1)),
          );
        }
        if (isKekNotReadyError(error)) {
          console.error(
            `[workos-vault] KEK still not ready after ${MAX_KEK_NOT_READY_ATTEMPTS} attempts ` +
              `for scope=${scopeId} secret=${secretId}; giving up.`,
          );
        }
        return Effect.fail(error);
      }),
    );

  return attemptWrite(MAX_WRITE_ATTEMPTS, MAX_KEK_NOT_READY_ATTEMPTS);
};

const deleteSecretValue = (
  client: WorkOSVaultClient,
  prefix: string,
  scopeId: string,
  secretId: string,
): Effect.Effect<boolean, WorkOSVaultClientError, never> =>
  Effect.gen(function* () {
    const existing = yield* loadSecretObject(client, prefix, scopeId, secretId);
    if (!existing) return false;
    yield* client.deleteObject({ id: existing.id });
    return true;
  });

// ---------------------------------------------------------------------------
// makeWorkOSVaultSecretProvider — builds a SecretProvider backed by
// WorkOS Vault for values and the plugin's own metadata table for
// names/purpose/createdAt.
// ---------------------------------------------------------------------------

export interface WorkOSVaultSecretProviderOptions {
  readonly client: WorkOSVaultClient;
  readonly store: WorkosVaultStore;
  readonly objectPrefix?: string;
  /**
   * Build the vault `context` map from an executor scope id. Each key
   * in the returned map becomes an independent dimension WorkOS uses
   * for KEK matching, so splitting compound scope ids into their
   * constituent fields (user/org) keeps per-KEK granularity aligned
   * with the real identities rather than an opaque compound string.
   * Defaults to `defaultWorkOSVaultContextForScope`.
   */
  readonly contextForScope?: WorkOSVaultContextForScope;
}

export const makeWorkOSVaultSecretProvider = (
  options: WorkOSVaultSecretProviderOptions,
): SecretProvider => {
  const prefix = options.objectPrefix ?? DEFAULT_OBJECT_PREFIX;
  const contextForScope = options.contextForScope ?? defaultWorkOSVaultContextForScope;
  const { client, store } = options;

  return {
    key: WORKOS_VAULT_PROVIDER_KEY,
    writable: true,

    get: (id, scope) =>
      Effect.gen(function* () {
        const meta = yield* store.get(id, scope);
        if (!meta) return null;
        const object = yield* loadSecretObject(client, prefix, scope, id).pipe(
          Effect.mapError(
            (error) =>
              new StorageError({
                message: "WorkOS Vault secret read failed",
                cause: error,
              }),
          ),
        );
        if (!object || !object.value) return null;
        return object.value;
      }),

    set: (id, value, scope) =>
      Effect.gen(function* () {
        const existing = yield* store.get(id, scope);
        yield* upsertSecretValue(client, prefix, scope, id, value, contextForScope).pipe(
          Effect.mapError(
            (error) =>
              new StorageError({
                message: "WorkOS Vault secret write failed",
                cause: error,
              }),
          ),
        );
        yield* store.upsert({
          id,
          scope_id: scope,
          name: existing?.name ?? id,
          purpose: existing?.purpose ?? null,
          created_at: existing?.created_at ?? new Date(),
        });
      }),

    delete: (id, scope) =>
      Effect.gen(function* () {
        const meta = yield* store.get(id, scope);
        if (!meta) return false;
        yield* deleteSecretValue(client, prefix, scope, id).pipe(
          Effect.mapError(
            (error) =>
              new StorageError({
                message: "WorkOS Vault secret delete failed",
                cause: error,
              }),
          ),
        );
        yield* store.remove(id, scope);
        return true;
      }),

    list: () =>
      store.list().pipe(Effect.map((rows) => rows.map((r) => ({ id: r.id, name: r.name })))),
  };
};
