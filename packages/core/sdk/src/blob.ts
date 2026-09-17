// ---------------------------------------------------------------------------
// BlobStore — the seam for large, opaque, write-once data. Blobs are stored
// in FumaDB with their own lifecycle and namespacing, separate from integration
// metadata and plugin-owned config rows.
//
// Plugins see a `PluginBlobStore` that's already namespaced to the
// plugin id and clamped to the product's `BlobAccess` view. Reads fall
// through the view's owners in order (first listed wins); writes and
// deletes require an explicit owner naming where the operation should
// land, and are refused outside the view. That mirrors the secrets API —
// shadowing by key on read, explicit target on write — and it is where
// the executor's access decisions apply to blobs at all: the blob table
// sits outside the storage owner policy (isolation is the namespace
// string), so nothing downstream re-checks them.
//
// Error channel is `StorageError` — blobs only do read/write/delete, so
// they never produce `UniqueViolationError`. The HTTP edge translates
// `StorageError` to the opaque public `InternalError({ traceId })`.
// ---------------------------------------------------------------------------

import { Effect, Predicate } from "effect";

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
}

export interface PluginBlobStore {
  /** Read precedence: the product view's owner order (`BlobAccess.owners`,
   *  first entry wins). Returns the first non-null. */
  readonly get: (key: string) => Effect.Effect<string | null, StorageError>;
  /** Write `value` under `key` for the named owner (`"org"` shared, `"user"`
   *  private). The owner must be in the product view, and `"user"` requires
   *  the executor to be bound to a subject. */
  readonly put: (
    key: string,
    value: string,
    options: { readonly owner: Owner },
  ) => Effect.Effect<void, StorageError>;
  /** Delete `key` for the named owner. Bounded like `put`. */
  readonly delete: (
    key: string,
    options: { readonly owner: Owner },
  ) => Effect.Effect<void, StorageError>;
  /** True if any partition in the product view has a value for `key`. */
  readonly has: (key: string) => Effect.Effect<boolean, StorageError>;
}

/** The owner partition strings an executor IDENTITY resolves to: the org
 *  partition (always present) and this subject's user partition (null for a
 *  pure-org executor). Identity-shaped on purpose — identity-bound consumers
 *  (the pending-approval store) keep using it directly; which partitions a
 *  plugin blob store actually reads or writes is the separate, product-owned
 *  `BlobAccess` decision. */
export interface OwnerPartitions {
  readonly org: string;
  readonly user: string | null;
}

/**
 * The slice of the product's access decisions the blob seam enforces: the
 * blob table is exempt from the storage owner policy (isolation lives in the
 * row namespace), so `ExecutorAccess.owners` and the read-only capability
 * must be applied HERE, at namespace construction, or not at all.
 *
 * Structural and required — there is no default view: the caller states the
 * product's decision explicitly, and core contributes only the clamps
 * (tenant/subject are already baked into `OwnerPartitions`).
 */
export interface BlobAccess {
  /** The owner partitions reads see and writes may target, in read-precedence
   *  order — the first listed owner shadows later ones on `get`. */
  readonly owners: readonly Owner[];
  /** `"denied"` refuses every `put`/`delete` through this store (the
   *  read-only posture, `ExecutorAccessCapabilities.storageWrites`). */
  readonly storageWrites: "allowed" | "denied";
}

const nsFor = (partition: string, pluginId: string) => `${partition}/${pluginId}`;

/**
 * Bind a `BlobStore` to an owner partitioning + plugin id, clamped to the
 * product's `BlobAccess`. Reads fall through the access owners in their
 * supplied order (first hit wins); writes target an explicit owner and are
 * refused outside the access view. Used by the executor to build the `blobs`
 * field handed to each plugin's `storage` factory.
 */
export const pluginBlobStore = (
  store: BlobStore,
  partitions: OwnerPartitions,
  pluginId: string,
  access: BlobAccess,
): PluginBlobStore => {
  const partitionOf = (owner: Owner): string | null =>
    owner === "org" ? partitions.org : partitions.user;

  // The product view's partitions, in ITS precedence order. An owner the
  // identity cannot carry (`"user"` with no subject) maps to no namespace
  // rather than failing a read — the partition simply has no rows to see.
  const readNamespaces: readonly string[] = access.owners
    .map(partitionOf)
    .filter(Predicate.isNotNull)
    .map((partition) => nsFor(partition, pluginId));

  const partitionFor = (owner: Owner): Effect.Effect<string, StorageError> => {
    if (access.storageWrites === "denied") {
      return Effect.fail(
        new StorageError({
          message: `Blob write on plugin "${pluginId}" is not allowed: this executor's storage is read-only.`,
          cause: undefined,
        }),
      );
    }
    if (!access.owners.includes(owner)) {
      return Effect.fail(
        new StorageError({
          message: `Blob write targets the "${owner}" partition, which this product view does not include.`,
          cause: undefined,
        }),
      );
    }
    const partition = partitionOf(owner);
    if (partition == null) {
      return Effect.fail(
        new StorageError({
          message: 'Blob write targets owner "user" but the executor has no subject.',
          cause: undefined,
        }),
      );
    }
    return Effect.succeed(partition);
  };

  return {
    get: (key) =>
      Effect.gen(function* () {
        const hits = yield* store.getMany(readNamespaces, key);
        if (hits.size === 0) return null;
        for (const ns of readNamespaces) {
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
    has: (key) => store.getMany(readNamespaces, key).pipe(Effect.map((hits) => hits.size > 0)),
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
