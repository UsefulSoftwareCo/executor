import { Effect, Option, Predicate, Schema } from "effect";

import {
  type CredentialProvider,
  Owner,
  type OwnerBinding,
  type PluginStorageEntry,
  ProviderItemId,
  ProviderKey,
  StorageError,
  type StorageDeps,
  type StorageFailure,
} from "@executor-js/sdk/core";

import {
  type WorkOSVaultClient,
  type WorkOSVaultClientError,
  type WorkOSVaultObject,
} from "./client";

export const WORKOS_VAULT_PROVIDER_KEY = ProviderKey.make("workos-vault");

const DEFAULT_OBJECT_PREFIX = "executor";
const MAX_WRITE_ATTEMPTS = 3;
// WorkOS creates a per-context KEK just-in-time on first write; a create
// call immediately after that provisioning step can race with the KEK
// becoming usable and return a transient error whose message ends in
// "KEK was created but is not yet ready. This request can be retried."
// We back off and retry the whole attempt (read + create) a few times.
const MAX_KEK_NOT_READY_ATTEMPTS = 20;
const KEK_NOT_READY_BACKOFF_MS = 1000;

// The vault `context` is the KEK-matching dimension. In v2 the connection row
// owns the (tenant, owner, subject) partition, so the provider no longer
// derives context from a scope id — it sees only an opaque `ProviderItemId`.
// We use a single, flat, provider-private context so every object shares one
// KEK. Each value key here stays colon-free by construction, sidestepping the
// "KEK was created but is not yet ready" hang we previously hit when a context
// value contained `:`.
const VAULT_CONTEXT: Record<string, string> = { app: "executor" };

// ---------------------------------------------------------------------------
// Metadata storage — values live in WorkOS Vault; regular plugin storage
// tracks what we know about and lets us enumerate. Keyed by the opaque
// `ProviderItemId`; writes carry the executor's `owner` binding.
// ---------------------------------------------------------------------------

const METADATA_COLLECTION = "metadata";

const WorkosVaultMetadataData = Schema.Struct({
  name: Schema.String,
  purpose: Schema.NullOr(Schema.String),
  createdAt: Schema.DateFromString,
});

type WorkosVaultMetadataDataEncoded = typeof WorkosVaultMetadataData.Encoded;

type MetadataRow = {
  readonly id: string;
  readonly name: string;
  readonly purpose: string | null;
  readonly created_at: Date;
};

const decodeJson = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Unknown));
const decodeMetadataData = Schema.decodeUnknownOption(WorkosVaultMetadataData);

const coerceJson = (value: unknown): unknown => {
  if (typeof value !== "string") return value;
  return Option.getOrElse(decodeJson(value), () => value);
};

const metadataData = (row: MetadataRow): WorkosVaultMetadataDataEncoded => ({
  name: row.name,
  purpose: row.purpose,
  createdAt: row.created_at.toISOString(),
});

const entryToMetadataRow = (entry: PluginStorageEntry): MetadataRow | null =>
  Option.match(decodeMetadataData(coerceJson(entry.data)), {
    onNone: () => null,
    onSome: (data: WorkosVaultMetadataData): MetadataRow => ({
      id: entry.key,
      name: data.name,
      purpose: data.purpose,
      created_at: data.createdAt,
    }),
  });

type WorkosVaultMetadataData = typeof WorkosVaultMetadataData.Type;

/** Map the executor's (tenant, subject?) binding onto the storage `Owner`
 *  literal: a bound subject writes the user's own partition, otherwise the
 *  org-shared one. Fallback only — prefer `ownerForItemId`. */
const ownerOf = (binding: OwnerBinding): Owner =>
  binding.subject == null ? Owner.make("org") : Owner.make("user");

// Item ids whose SECOND colon-segment is the owning partition:
//   connection:<owner>:<integration>:<name>:<variable>
//   oauth:<owner>:<integration>:<name>[:refresh]
//   oauth-client:<owner>:<slug>:secret
const OWNER_SCOPED_PREFIXES: ReadonlySet<string> = new Set(["connection", "oauth", "oauth-client"]);

/** The partition a credential's metadata belongs to: the CREDENTIAL's owner
 *  (embedded in the item id), NOT the acting caller's binding. An org member
 *  creating a workspace connection must file org-shared metadata so every
 *  other member can resolve it — filing under the creator's user partition
 *  (the old `ownerOf(binding)` behavior) made shared credentials resolvable
 *  only by whoever pasted them. Ids without an embedded owner fall back to the
 *  caller binding. */
const ownerForItemId = (id: string, binding: OwnerBinding): Owner => {
  const [prefix, owner] = id.split(":");
  if (OWNER_SCOPED_PREFIXES.has(prefix ?? "") && (owner === "org" || owner === "user")) {
    return Owner.make(owner);
  }
  return ownerOf(binding);
};

// ---------------------------------------------------------------------------
// WorkosVaultStore — typed metadata-store the plugin uses internally.
//
// v2: keyed solely by the opaque `ProviderItemId`. Writes carry the executor's
// `owner` (so plugin storage knows which partition to file under); reads/list
// are not owner-filtered — the connection row that references the id owns the
// partition.
// ---------------------------------------------------------------------------

export interface WorkosVaultStore {
  readonly get: (id: string) => Effect.Effect<MetadataRow | null, StorageFailure>;
  readonly upsert: (row: MetadataRow) => Effect.Effect<void, StorageFailure>;
  readonly remove: (id: string) => Effect.Effect<boolean, StorageFailure>;
  readonly list: () => Effect.Effect<readonly MetadataRow[], StorageFailure>;
}

export const makeWorkosVaultStore = (deps: StorageDeps): WorkosVaultStore => {
  const { pluginStorage } = deps;

  const find = (id: string): Effect.Effect<MetadataRow | null, StorageFailure> =>
    pluginStorage
      .get({ collection: METADATA_COLLECTION, key: id })
      .pipe(
        Effect.map((entry: PluginStorageEntry | null): MetadataRow | null =>
          entry ? entryToMetadataRow(entry) : null,
        ),
      );

  return {
    get: (id: string) => find(id),
    upsert: (row: MetadataRow) =>
      pluginStorage
        .put({
          owner: ownerForItemId(row.id, deps.owner),
          collection: METADATA_COLLECTION,
          key: row.id,
          data: metadataData(row),
        })
        .pipe(Effect.asVoid),
    remove: (id: string) =>
      Effect.gen(function* () {
        const existing = yield* find(id);
        if (!existing) return false;
        yield* pluginStorage.remove({
          owner: ownerForItemId(id, deps.owner),
          collection: METADATA_COLLECTION,
          key: id,
        });
        return true;
      }),
    list: () =>
      pluginStorage.list({ collection: METADATA_COLLECTION }).pipe(
        Effect.map((rows: readonly PluginStorageEntry[]): readonly MetadataRow[] =>
          rows
            .map(entryToMetadataRow)
            .filter(Predicate.isNotNull)
            .sort(
              (l: MetadataRow, r: MetadataRow) => l.created_at.getTime() - r.created_at.getTime(),
            ),
        ),
      ),
  };
};

// ---------------------------------------------------------------------------
// Vault helpers — opaque-id object naming + 409-retry upsert.
//
// v2: the object name is derived solely from the opaque provider item id; the
// scope segment (and its legacy unencoded fallback) is gone. We still
// URL-encode the id segment because opaque ids can carry `/`, `:`, etc.
// ---------------------------------------------------------------------------

const isStatusError = (error: WorkOSVaultClientError, status: number): boolean =>
  error.status === status;

const isKekNotReadyError = (error: WorkOSVaultClientError): boolean =>
  error.retryKind === "kek_not_ready";

const encodeObjectNameSegment = (segment: string): string => encodeURIComponent(segment);

const secretObjectName = (prefix: string, secretId: string): string =>
  `${prefix}/secrets/${encodeObjectNameSegment(secretId)}`;

const loadSecretObject = (
  client: WorkOSVaultClient,
  prefix: string,
  secretId: string,
): Effect.Effect<WorkOSVaultObject | null, WorkOSVaultClientError, never> =>
  client.readObjectByName(secretObjectName(prefix, secretId)).pipe(
    Effect.catch((error: WorkOSVaultClientError) => {
      // 400 (invalid name) and 404 (absent) both mean "no value here".
      if (isStatusError(error, 400) || isStatusError(error, 404)) return Effect.succeed(null);
      return Effect.fail(error);
    }),
  );

const upsertSecretValue = (
  client: WorkOSVaultClient,
  prefix: string,
  secretId: string,
  value: string,
): Effect.Effect<void, WorkOSVaultClientError, never> => {
  const attemptWrite = (
    remainingConflictAttempts: number,
    remainingKekAttempts: number,
  ): Effect.Effect<void, WorkOSVaultClientError, never> =>
    Effect.gen(function* () {
      const existing = yield* loadSecretObject(client, prefix, secretId);

      if (existing) {
        yield* client.updateObject({
          id: existing.id,
          value,
          versionCheck: existing.metadata.versionId,
        });
        return;
      }

      yield* client.createObject({
        name: secretObjectName(prefix, secretId),
        value,
        context: VAULT_CONTEXT,
      });
    }).pipe(
      Effect.catch((error: WorkOSVaultClientError) => {
        if (remainingConflictAttempts > 1 && isStatusError(error, 409)) {
          return attemptWrite(remainingConflictAttempts - 1, remainingKekAttempts);
        }
        if (remainingKekAttempts > 1 && isKekNotReadyError(error)) {
          console.warn(
            `[workos-vault] KEK not ready for secret=${secretId} — ` +
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
              `for secret=${secretId}; giving up.`,
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
  secretId: string,
): Effect.Effect<boolean, WorkOSVaultClientError, never> =>
  Effect.gen(function* () {
    const existing = yield* loadSecretObject(client, prefix, secretId);
    if (!existing) return false;
    yield* client.deleteObject({ id: existing.id });
    return true;
  });

// ---------------------------------------------------------------------------
// makeWorkOSVaultCredentialProvider — builds a CredentialProvider backed by
// WorkOS Vault for values and the plugin's own metadata table for
// names/purpose/createdAt.
//
// v2: the provider sees only an opaque `ProviderItemId` — there is NO scope
// arg. The connection row that references the id owns the (tenant, owner,
// subject) partition. `delete` returns void; absence is not an error.
// ---------------------------------------------------------------------------

export interface WorkOSVaultCredentialProviderOptions {
  readonly client: WorkOSVaultClient;
  readonly store: WorkosVaultStore;
  readonly objectPrefix?: string;
}

export const makeWorkOSVaultCredentialProvider = (
  options: WorkOSVaultCredentialProviderOptions,
): CredentialProvider => {
  const prefix = options.objectPrefix ?? DEFAULT_OBJECT_PREFIX;
  const { client, store } = options;

  return {
    key: WORKOS_VAULT_PROVIDER_KEY,
    writable: true,

    get: (id: ProviderItemId) =>
      Effect.gen(function* () {
        const meta = yield* store.get(id);
        if (!meta) return null;
        const object = yield* loadSecretObject(client, prefix, id).pipe(
          Effect.mapError(
            (error: WorkOSVaultClientError) =>
              new StorageError({
                message: "WorkOS Vault secret read failed",
                cause: error,
              }),
          ),
        );
        if (!object || !object.value) return null;
        return object.value;
      }),

    has: (id: ProviderItemId) => store.get(id).pipe(Effect.map((meta) => meta !== null)),

    set: (id: ProviderItemId, value: string) =>
      Effect.gen(function* () {
        const existing = yield* store.get(id);
        yield* upsertSecretValue(client, prefix, id, value).pipe(
          Effect.mapError(
            (error: WorkOSVaultClientError) =>
              new StorageError({
                message: "WorkOS Vault secret write failed",
                cause: error,
              }),
          ),
        );
        yield* store.upsert({
          id,
          name: existing?.name ?? id,
          purpose: existing?.purpose ?? null,
          created_at: existing?.created_at ?? new Date(),
        });
      }),

    delete: (id: ProviderItemId) =>
      Effect.gen(function* () {
        const meta = yield* store.get(id);
        if (!meta) return;
        yield* deleteSecretValue(client, prefix, id).pipe(
          Effect.mapError(
            (error: WorkOSVaultClientError) =>
              new StorageError({
                message: "WorkOS Vault secret delete failed",
                cause: error,
              }),
          ),
        );
        yield* store.remove(id);
      }),

    list: () =>
      store
        .list()
        .pipe(
          Effect.map((rows: readonly MetadataRow[]) =>
            rows.map((r: MetadataRow) => ({ id: ProviderItemId.make(r.id), name: r.name })),
          ),
        ),
  };
};
