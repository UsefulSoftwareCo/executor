import { Effect, Option, Predicate, Schema } from "effect";

import {
  type CredentialProvider,
  embeddedItemOwner,
  ownerForItemId,
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
// Version-checked write attempts before the last-resort un-versioned write.
// Contention here is a peer writer persisting the SAME credential (two
// concurrent refreshes of one connection), so retries must be spaced: a tight
// loop re-reads and re-writes inside the peer's own round trip and collides
// again deterministically.
const MAX_WRITE_ATTEMPTS = 5;
const WRITE_CONFLICT_BACKOFF_BASE_MS = 50;
const WRITE_CONFLICT_BACKOFF_CAP_MS = 800;
// WorkOS creates a per-context KEK just-in-time on first write; a create
// call immediately after that provisioning step can race with the KEK
// becoming usable and return a transient error whose message ends in
// "KEK was created but is not yet ready. This request can be retried."
// We back off and retry the whole attempt (read + create) a few times.
const MAX_KEK_NOT_READY_ATTEMPTS = 20;
const KEK_NOT_READY_BACKOFF_MS = 1000;

// The vault `context` is the KEK-matching dimension — WorkOS provisions one KEK
// per distinct context, so it doubles as a cryptographic partition. Object
// names alone already isolate partitions (see `secretObjectName`); the context
// makes that isolation cryptographic so a partition's objects can only be
// decrypted under its own KEK. Each value stays colon-free by construction
// (tenant/subject ids contain no `:`), sidestepping the "KEK was created but is
// not yet ready" hang we previously hit when a context value contained `:`.

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
// Vault helpers — partition-scoped object naming + 409-retry upsert.
//
// The object name encodes the credential's partition, because a logical item id
// (`connection:`/`oauth:`/`oauth-client:`) carries no tenant and no subject — two
// tenants (or two users) that pick the same integration + name derive the same
// id, so the name must add the partition to keep their objects distinct. We
// scope by tenant always, and by subject for user-owned credentials (org
// credentials are shared across a tenant's members, so they stay subject-less —
// mirroring `ownerForItemId`). Legacy random `secret_*` ids are globally unique
// already, so they keep their flat, unscoped name and existing objects keep
// resolving unchanged. Segments are URL-encoded because ids can carry `/`, `:`.
// ---------------------------------------------------------------------------

const isStatusError = (error: WorkOSVaultClientError, status: number): boolean =>
  error.status === status;

const isKekNotReadyError = (error: WorkOSVaultClientError): boolean =>
  error.retryKind === "kek_not_ready";

const encodeObjectNameSegment = (segment: string): string => encodeURIComponent(segment);

// WorkOS Vault accepts createObject names of any length but every read of an
// object whose name exceeds 200 characters fails with 400 — by name AND by id
// (verified empirically against the live API, 2026-06-10: 200 reads fine, 201
// is permanently unreadable). Names that would exceed the limit swap the
// encoded-id tail for a sha256 digest; the partition segments stay literal so
// the name remains attributable. `h~` cannot collide with an encoded literal
// id: every owner-scoped id starts with its `connection`/`oauth`/`oauth-client`
// prefix, never `h~`.
const MAX_OBJECT_NAME_LENGTH = 200;

const sha256Base64Url = (input: string): Effect.Effect<string> =>
  Effect.promise(async () => {
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
    let binary = "";
    for (const byte of new Uint8Array(digest)) binary += String.fromCharCode(byte);
    return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
  });

/** Partition path segments for a logical item id, or null for legacy ids that
 *  carry no embedded owner (those keep the flat, unscoped name). */
const objectScopeSegments = (id: string, binding: OwnerBinding): readonly string[] | null => {
  const owner = embeddedItemOwner(id);
  if (owner === null) return null;
  const tenant = encodeObjectNameSegment(String(binding.tenant));
  return owner === "user"
    ? ["user", tenant, encodeObjectNameSegment(String(binding.subject ?? ""))]
    : ["org", tenant];
};

const secretObjectName = (
  prefix: string,
  id: string,
  binding: OwnerBinding,
): Effect.Effect<string> =>
  Effect.gen(function* () {
    const scope = objectScopeSegments(id, binding);
    const head = scope === null ? prefix : `${prefix}/${scope.join("/")}`;
    const name = `${head}/secrets/${encodeObjectNameSegment(id)}`;
    if (name.length <= MAX_OBJECT_NAME_LENGTH) return name;
    return `${head}/secrets/h~${yield* sha256Base64Url(id)}`;
  });

/** KEK-matching context for a credential. Logical ids get a per-tenant (and
 *  per-user) context so WorkOS provisions an isolated KEK per partition; legacy
 *  ids keep the original shared context so existing objects stay decryptable. */
const vaultContextFor = (id: string, binding: OwnerBinding): Record<string, string> => {
  const owner = embeddedItemOwner(id);
  if (owner === null) return { app: "executor" };
  const context: Record<string, string> = {
    app: "executor",
    organization_id: String(binding.tenant),
  };
  if (owner === "user") context.user_id = String(binding.subject ?? "");
  return context;
};

const loadSecretObject = (
  client: WorkOSVaultClient,
  name: string,
): Effect.Effect<WorkOSVaultObject | null, WorkOSVaultClientError, never> =>
  client.readObjectByName(name).pipe(
    Effect.catch((error: WorkOSVaultClientError) => {
      // 400 (invalid name) and 404 (absent) both mean "no value here".
      if (isStatusError(error, 400) || isStatusError(error, 404)) return Effect.succeed(null);
      return Effect.fail(error);
    }),
  );

/** Half-jittered exponential backoff for attempt `n` (1-based): a wait drawn
 *  from [d/2, d) where d = base * 2^(n-1), capped. The jitter matters more than
 *  the delay — two writers that back off by the same amount simply collide
 *  again one beat later. */
const writeConflictBackoffMillis = (attempt: number): number => {
  const ceiling = Math.min(
    WRITE_CONFLICT_BACKOFF_BASE_MS * 2 ** (attempt - 1),
    WRITE_CONFLICT_BACKOFF_CAP_MS,
  );
  return ceiling / 2 + Math.random() * (ceiling / 2);
};

/** A version-checked write either landed or lost the race to a peer writer. */
type WriteOutcome = "written" | "contended";

/** Did this update failure mean "someone else wrote first"? 409 is the
 *  documented answer. WorkOS also answers 400 when the version we checked
 *  against is several generations behind, and an update carries no name and no
 *  context — the only inputs are the id, the value, and the version — so a 400
 *  here is contention too, not a malformed request. If it really were
 *  malformed, the un-versioned last-resort write fails the same way and the
 *  error still surfaces. */
const isWriteContention = (error: WorkOSVaultClientError): boolean =>
  isStatusError(error, 409) || isStatusError(error, 400);

const upsertSecretValue = (
  client: WorkOSVaultClient,
  name: string,
  value: string,
  context: Record<string, string>,
): Effect.Effect<void, WorkOSVaultClientError, never> => {
  const attemptOnce = (): Effect.Effect<WriteOutcome, WorkOSVaultClientError, never> =>
    Effect.gen(function* () {
      const existing = yield* loadSecretObject(client, name);

      if (existing) {
        return yield* client
          .updateObject({ id: existing.id, value, versionCheck: existing.metadata.versionId })
          .pipe(
            Effect.as<WriteOutcome>("written"),
            Effect.catch((error: WorkOSVaultClientError) =>
              isWriteContention(error)
                ? Effect.succeed<WriteOutcome>("contended")
                : Effect.fail(error),
            ),
          );
      }

      return yield* client.createObject({ name, value, context }).pipe(
        Effect.as<WriteOutcome>("written"),
        // A peer created the object between our read and our create; the next
        // attempt re-reads it and takes the update path.
        Effect.catch((error: WorkOSVaultClientError) =>
          isStatusError(error, 409)
            ? Effect.succeed<WriteOutcome>("contended")
            : Effect.fail(error),
        ),
      );
    });

  /** Last resort once every version-checked attempt lost: write without a
   *  version check. Both racers are persisting a credential they just minted,
   *  so last-writer-wins keeps a usable value; failing instead discards a
   *  freshly minted, often single-use credential, which is the one outcome
   *  that leaves a connection with nothing it can use. */
  const blindWrite = (): Effect.Effect<void, WorkOSVaultClientError, never> =>
    Effect.gen(function* () {
      const existing = yield* loadSecretObject(client, name);
      if (!existing) {
        yield* client.createObject({ name, value, context });
        return;
      }
      console.warn(
        `[workos-vault] version-checked write for object=${name} lost ` +
          `${MAX_WRITE_ATTEMPTS} races; writing without a version check`,
      );
      yield* client.updateObject({ id: existing.id, value });
    });

  const attemptWrite = (
    attempt: number,
    remainingKekAttempts: number,
  ): Effect.Effect<void, WorkOSVaultClientError, never> =>
    attemptOnce().pipe(
      Effect.flatMap((outcome: WriteOutcome) => {
        if (outcome === "written") return Effect.void;
        if (attempt >= MAX_WRITE_ATTEMPTS) return blindWrite();
        return Effect.sleep(writeConflictBackoffMillis(attempt)).pipe(
          Effect.flatMap(() => attemptWrite(attempt + 1, remainingKekAttempts)),
        );
      }),
      Effect.catch((error: WorkOSVaultClientError) => {
        if (remainingKekAttempts > 1 && isKekNotReadyError(error)) {
          console.warn(
            `[workos-vault] KEK not ready for object=${name} — ` +
              `retrying in ${KEK_NOT_READY_BACKOFF_MS}ms ` +
              `(${MAX_KEK_NOT_READY_ATTEMPTS - remainingKekAttempts + 1}/${MAX_KEK_NOT_READY_ATTEMPTS})`,
          );
          return Effect.sleep(KEK_NOT_READY_BACKOFF_MS).pipe(
            Effect.flatMap(() => attemptWrite(attempt, remainingKekAttempts - 1)),
          );
        }
        if (isKekNotReadyError(error)) {
          console.error(
            `[workos-vault] KEK still not ready after ${MAX_KEK_NOT_READY_ATTEMPTS} attempts ` +
              `for object=${name}; giving up.`,
          );
        }
        return Effect.fail(error);
      }),
    );

  return attemptWrite(1, MAX_KEK_NOT_READY_ATTEMPTS);
};

const deleteSecretValue = (
  client: WorkOSVaultClient,
  name: string,
): Effect.Effect<boolean, WorkOSVaultClientError, never> =>
  Effect.gen(function* () {
    const existing = yield* loadSecretObject(client, name);
    if (!existing) return false;
    yield* client.deleteObject({ id: existing.id });
    return true;
  });

// ---------------------------------------------------------------------------
// makeWorkOSVaultCredentialProvider — builds a CredentialProvider backed by
// WorkOS Vault for values and the plugin's own metadata table for
// names/purpose/createdAt.
//
// The provider sees an opaque `ProviderItemId` plus the request's `owner`
// binding (tenant + subject). It derives the vault object name and KEK context
// from both, so a credential's object is scoped to its partition. The
// connection row that references the id owns the (tenant, owner, subject)
// partition. `delete` returns void; absence is not an error.
// ---------------------------------------------------------------------------

export interface WorkOSVaultCredentialProviderOptions {
  readonly client: WorkOSVaultClient;
  readonly store: WorkosVaultStore;
  /** The request's owner binding (tenant + subject). Scopes the vault object
   *  name and KEK context so credentials cannot collide across partitions. */
  readonly owner: OwnerBinding;
  readonly objectPrefix?: string;
}

export const makeWorkOSVaultCredentialProvider = (
  options: WorkOSVaultCredentialProviderOptions,
): CredentialProvider => {
  const prefix = options.objectPrefix ?? DEFAULT_OBJECT_PREFIX;
  const { client, store, owner } = options;
  const nameFor = (id: ProviderItemId): Effect.Effect<string> =>
    secretObjectName(prefix, id, owner);

  return {
    key: WORKOS_VAULT_PROVIDER_KEY,
    writable: true,

    get: (id: ProviderItemId) =>
      Effect.gen(function* () {
        const meta = yield* store.get(id);
        if (!meta) return null;
        const object = yield* loadSecretObject(client, yield* nameFor(id)).pipe(
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
        yield* upsertSecretValue(
          client,
          yield* nameFor(id),
          value,
          vaultContextFor(id, owner),
        ).pipe(
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
        yield* deleteSecretValue(client, yield* nameFor(id)).pipe(
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
