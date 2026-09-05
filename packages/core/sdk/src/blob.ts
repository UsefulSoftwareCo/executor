// ---------------------------------------------------------------------------
// BlobStore — the seam for large, opaque, write-once data. Blobs are stored
// in FumaDB with their own lifecycle and namespacing, separate from integration
// metadata and plugin-owned config rows.
//
// Plugins see a `PluginBlobStore` that's already namespaced to the
// plugin id and bound to the executor's scope stack. Reads fall through
// the stack in order (innermost first, first hit wins); writes and
// deletes require an explicit scope id naming where the operation
// should land. That mirrors the secrets API — shadowing by key on
// read, explicit target on write.
//
// Error channel is `StorageError` — blobs only do read/write/delete, so
// they never produce `UniqueViolationError`. The HTTP edge translates
// `StorageError` to the opaque public `InternalError({ traceId })`.
// ---------------------------------------------------------------------------

import { Effect } from "effect";

import { StorageError, type IFumaClient } from "./fuma-runtime";
import type { Owner } from "./ids";

export interface BlobStore {
  readonly get: (namespace: string, key: string) => Effect.Effect<string | null, StorageError>;
  /** Multi-namespace lookup for a single key. Backends issue one query
   *  (`WHERE namespace IN (...) AND key = ?`) and return the hits keyed
   *  by namespace — the caller applies its own precedence. Lets
   *  `pluginBlobStore` walk the scope stack in O(1) round-trips instead
   *  of one per scope. */
  readonly getMany: (
    namespaces: readonly string[],
    key: string,
  ) => Effect.Effect<ReadonlyMap<string, string>, StorageError>;
  readonly put: (
    namespace: string,
    key: string,
    value: string,
  ) => Effect.Effect<void, StorageError>;
  readonly delete: (namespace: string, key: string) => Effect.Effect<void, StorageError>;
  readonly has: (namespace: string, key: string) => Effect.Effect<boolean, StorageError>;
  /**
   * Atomically delete a record IF it exists. Returns true iff this caller's
   * delete removed an existing record; false iff it was already absent.
   *
   * The single-winner invariant: exactly one concurrent caller observes true
   * for a given (namespace, key); everyone else observes false, and the
   * post-condition is that the record is absent for all callers. There is no
   * read-your-undefined window — a caller that observed true is guaranteed
   * the record was present at deletion time, and no other caller can observe
   * true for the same key afterwards.
   *
   * Implementations MUST NOT do check-then-act across two statements:
   * either a single atomic statement with a rows-affected/count check, or
   * get+delete inside a serializing transaction (libSQL/Postgres
   * `fuma.transaction`), or a single synchronous Map op (in-memory).
   */
  readonly compareAndDelete: (
    namespace: string,
    key: string,
  ) => Effect.Effect<boolean, StorageError>;
}

export interface PluginBlobStore {
  /** Read precedence: this subject's own (`user`) value first, then the
   *  org-shared value. Returns the first non-null. */
  readonly get: (key: string) => Effect.Effect<string | null, StorageError>;
  /** Write `value` under `key` for the named owner (`"org"` shared, `"user"`
   *  private). `"user"` requires the executor to be bound to a subject. */
  readonly put: (
    key: string,
    value: string,
    options: { readonly owner: Owner },
  ) => Effect.Effect<void, StorageError>;
  /** Delete `key` for the named owner. */
  readonly delete: (
    key: string,
    options: { readonly owner: Owner },
  ) => Effect.Effect<void, StorageError>;
  /** True if either the user or org partition has a value for `key`. */
  readonly has: (key: string) => Effect.Effect<boolean, StorageError>;
}

/** The owner partition strings an executor binding resolves to: the org
 *  partition (always present) and this subject's user partition (null for a
 *  pure-org executor). Reads walk `[user, org]`; writes target one. */
export interface OwnerPartitions {
  readonly org: string;
  readonly user: string | null;
}

const nsFor = (partition: string, pluginId: string) => `${partition}/${pluginId}`;

/**
 * Bind a `BlobStore` to an owner partitioning + plugin id. Reads fall through
 * `[user, org]` (user first); writes target an explicit owner. Used by the
 * executor to build the `blobs` field handed to each plugin's `storage` factory.
 */
export const pluginBlobStore = (
  store: BlobStore,
  partitions: OwnerPartitions,
  pluginId: string,
): PluginBlobStore => {
  const readNamespaces = (): readonly string[] =>
    (partitions.user == null ? [partitions.org] : [partitions.user, partitions.org]).map((p) =>
      nsFor(p, pluginId),
    );

  const partitionFor = (owner: Owner): Effect.Effect<string, StorageError> => {
    if (owner === "org") return Effect.succeed(partitions.org);
    if (partitions.user == null) {
      return Effect.fail(
        new StorageError({
          message: 'Blob write targets owner "user" but the executor has no subject.',
          cause: undefined,
        }),
      );
    }
    return Effect.succeed(partitions.user);
  };

  return {
    get: (key) =>
      Effect.gen(function* () {
        const namespaces = readNamespaces();
        const hits = yield* store.getMany(namespaces, key);
        if (hits.size === 0) return null;
        for (const ns of namespaces) {
          const v = hits.get(ns);
          if (v !== undefined) return v;
        }
        return null;
      }),
    put: (key, value, options) =>
      Effect.flatMap(partitionFor(options.owner), (partition) =>
        store.put(nsFor(partition, pluginId), key, value),
      ),
    delete: (key, options) =>
      Effect.flatMap(partitionFor(options.owner), (partition) =>
        store.delete(nsFor(partition, pluginId), key),
      ),
    has: (key) => store.getMany(readNamespaces(), key).pipe(Effect.map((hits) => hits.size > 0)),
  };
};

/**
 * Minimal in-memory BlobStore — good for tests and trivial hosts. Real
 * backends (filesystem, S3/R2, SQLite-table-backed) implement the same
 * interface.
 *
 * Every method is `Effect<_, never>` — a pure in-memory Map can't fail.
 * `never` is assignable to `StorageError`, so the result still fits the
 * `BlobStore` interface.
 */
export const makeInMemoryBlobStore = (): BlobStore => {
  const store = new Map<string, string>();
  const k = (ns: string, key: string) => `${ns}::${key}`;
  return {
    get: (ns, key) => Effect.sync(() => store.get(k(ns, key)) ?? null),
    getMany: (namespaces, key) =>
      Effect.sync(() => {
        const hits = new Map<string, string>();
        for (const ns of namespaces) {
          const v = store.get(k(ns, key));
          if (v !== undefined) hits.set(ns, v);
        }
        return hits;
      }),
    put: (ns, key, value) =>
      Effect.sync(() => {
        store.set(k(ns, key), value);
      }),
    delete: (ns, key) =>
      Effect.sync(() => {
        store.delete(k(ns, key));
      }),
    has: (ns, key) => Effect.sync(() => store.has(k(ns, key))),
    // Atomic by construction: a synchronous Map has+delete runs to completion
    // without yielding, so no other fiber can interleave between the check
    // and the delete in JS's single-threaded model.
    compareAndDelete: (ns, key) =>
      Effect.sync(() => {
        const id = k(ns, key);
        if (!store.has(id)) return false;
        store.delete(id);
        return true;
      }),
  };
};

/** Hex SHA-256 of a UTF-8 string — the content-address key plugins use for
 *  write-once blobs (`put(key(hash), …)` is then idempotent and orphaned
 *  writes are harmless). Web Crypto, so it runs on Workers/Bun/Node alike. */
export const sha256Hex = (text: string): Effect.Effect<string> =>
  Effect.promise(async () => {
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
    return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join(
      "",
    );
  });

const blobId = (namespace: string, key: string): string => JSON.stringify([namespace, key]);

type BlobRow = {
  readonly id: string;
  readonly namespace: string;
  readonly key: string;
  readonly value: string;
};

const toBlobRows = (rows: unknown): readonly BlobRow[] => rows as readonly BlobRow[];

export const makeFumaBlobStore = (fuma: IFumaClient): BlobStore => ({
  get: (namespace, key) =>
    fuma
      .use("blob.get", (db) =>
        db.findFirst("blob", {
          where: (b) => b.and(b("namespace", "=", namespace), b("key", "=", key)),
        }),
      )
      .pipe(Effect.map((row) => row as BlobRow | null))
      .pipe(
        Effect.map((row) => row?.value ?? null),
        Effect.mapError(
          (cause) => new StorageError({ message: "FumaDB blob operation failed", cause }),
        ),
      ),
  getMany: (namespaces, key) =>
    namespaces.length === 0
      ? Effect.succeed(new Map<string, string>())
      : fuma
          .use("blob.getMany", (db) =>
            db.findMany("blob", {
              where: (b) => b.and(b("namespace", "in", [...namespaces]), b("key", "=", key)),
            }),
          )
          .pipe(Effect.map(toBlobRows))
          .pipe(
            Effect.map((rows) => {
              const out = new Map<string, string>();
              for (const row of rows) out.set(row.namespace, row.value);
              return out;
            }),
            Effect.mapError(
              (cause) => new StorageError({ message: "FumaDB blob operation failed", cause }),
            ),
          ),
  put: (namespace, key, value) =>
    Effect.gen(function* () {
      const id = blobId(namespace, key);
      const existing = (yield* fuma.use("blob.findForPut", (db) =>
        db.findFirst("blob", { where: (b) => b("id", "=", id) }),
      )) as BlobRow | null;
      if (existing) {
        yield* fuma.use("blob.update", (db) =>
          db.updateMany("blob", { where: (b) => b("id", "=", id), set: { value } }),
        );
        return;
      }
      yield* fuma.use("blob.create", (db) => db.create("blob", { id, namespace, key, value }));
    }).pipe(
      Effect.mapError(
        (cause) => new StorageError({ message: "FumaDB blob operation failed", cause }),
      ),
    ),
  delete: (namespace, key) =>
    fuma
      .use("blob.delete", (db) =>
        db.deleteMany("blob", { where: (b) => b("id", "=", blobId(namespace, key)) }),
      )
      .pipe(
        Effect.asVoid,
        Effect.mapError(
          (cause) => new StorageError({ message: "FumaDB blob operation failed", cause }),
        ),
      ),
  compareAndDelete: (namespace, key) =>
    fuma
      .transaction(
        Effect.gen(function* () {
          const id = blobId(namespace, key);
          // Read inside the transaction: on libSQL/Postgres, `fuma.transaction`
          // runs real BEGIN/COMMIT, so concurrent transactions serialize and
          // no other fiber can interleave between this get and the delete —
          // exactly one caller observes a present row, everyone else sees
          // absent-after-commit. FumaDB's query builder discards rows-affected
          // counts (deleteMany -> Promise<void>) and exposes no raw driver
          // handle, so a single `DELETE ... RETURNING` statement is not
          // reachable through this abstraction without a cross-host driver
          // change; the serializing transaction is the equivalent guarantee
          // here. (The in-memory store's synchronous Map op is the atomic
          // counterpart.)
          const row = (yield* fuma.use("blob.cad.find", (db) =>
            db.findFirst("blob", { where: (b) => b("id", "=", id) }),
          )) as BlobRow | null;
          if (row === null) return false;
          yield* fuma.use("blob.cad.delete", (db) =>
            db.deleteMany("blob", { where: (b) => b("id", "=", id) }),
          );
          return true;
        }),
      )
      .pipe(
        Effect.mapError(
          (cause) => new StorageError({ message: "FumaDB blob operation failed", cause }),
        ),
      ),
  has: (namespace, key) =>
    fuma
      .use("blob.has", (db) =>
        db.count("blob", { where: (b) => b("id", "=", blobId(namespace, key)) }),
      )
      .pipe(
        Effect.map((count) => count > 0),
        Effect.mapError(
          (cause) => new StorageError({ message: "FumaDB blob operation failed", cause }),
        ),
      ),
});
