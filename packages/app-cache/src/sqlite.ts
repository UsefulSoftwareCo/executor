/** SQLite-backed cache, separate from app tables and owned by the app's supervisor. */
/** Minimal synchronous SQL adapter; implementations own the database handle. */
export interface CacheSqlStorage {
  readonly sql: {
    readonly exec: (
      query: string,
      ...bindings: (string | number | null)[]
    ) => {
      readonly toArray: () => readonly unknown[];
      readonly one: () => unknown;
    };
  };
  readonly transactionSync: <A>(work: () => A) => A;
}
import { Effect, Schema } from "effect";
import { CacheCommand, CacheEntry, CacheError, cacheLimits } from "./contracts/cache.ts";

const Row = Schema.Struct({
  value: Schema.NullOr(Schema.String),
  version: Schema.String,
  fresh: Schema.Number,
  stale: Schema.Number,
  lease: Schema.NullOr(Schema.String),
  lease_until: Schema.Number,
  bytes: Schema.Number,
});

/** Create a bounded, fenced cache store. All commands execute in a synchronous SQL transaction. */
export const sqliteCache = (storage: CacheSqlStorage) => {
  let initialized = false;
  return (namespace: string, input: unknown) =>
    Effect.try({
      try: (): Schema.Json => {
        const command = Schema.decodeUnknownSync(CacheCommand)(input);
        if (namespace.length > 256) throw new CacheError({ reason: "invalid" });
        if (!initialized) {
          storage.sql.exec(`CREATE TABLE IF NOT EXISTS executor_cache (
          namespace TEXT NOT NULL, key TEXT NOT NULL, value TEXT, version TEXT NOT NULL,
          fresh REAL NOT NULL, stale REAL NOT NULL, lease TEXT, lease_until REAL NOT NULL,
          bytes INTEGER NOT NULL, touched REAL NOT NULL, PRIMARY KEY(namespace, key)
        )`);
          storage.sql.exec(
            "CREATE INDEX IF NOT EXISTS executor_cache_expiry ON executor_cache(stale)",
          );
          initialized = true;
        }
        const now = Date.now();
        return storage.transactionSync(() => {
          // Expired entries are disposable. Active loaders keep their fencing row.
          storage.sql.exec(
            "DELETE FROM executor_cache WHERE stale < ? AND lease_until < ?",
            now,
            now,
          );
          const read = (key: string) => {
            const row = storage.sql
              .exec(
                "SELECT value, version, fresh, stale, lease, lease_until, bytes FROM executor_cache WHERE namespace = ? AND key = ?",
                namespace,
                key,
              )
              .toArray()[0];
            return row === undefined ? undefined : Schema.decodeUnknownSync(Row)(row);
          };
          const write = (key: string, entry: CacheEntry) => {
            const value = JSON.stringify(entry.value);
            const bytes = new TextEncoder().encode(value).byteLength;
            if (
              bytes > cacheLimits.entryBytes ||
              entry.staleUntil > now + cacheLimits.retentionMs ||
              entry.freshUntil > entry.staleUntil
            )
              throw new CacheError({ reason: "capacity" });
            storage.sql.exec(
              `INSERT INTO executor_cache VALUES (?, ?, ?, ?, ?, ?, NULL, 0, ?, ?)
            ON CONFLICT(namespace, key) DO UPDATE SET value=excluded.value, version=excluded.version,
            fresh=excluded.fresh, stale=excluded.stale, lease=NULL, lease_until=0, bytes=excluded.bytes, touched=excluded.touched`,
              namespace,
              key,
              value,
              entry.version,
              entry.freshUntil,
              entry.staleUntil,
              bytes,
              now,
            );
          };
          const bound = () => {
            const totals = Schema.decodeUnknownSync(
              Schema.Struct({ bytes: Schema.Number, count: Schema.Number }),
            )(
              storage.sql
                .exec(
                  "SELECT coalesce(sum(bytes), 0) as bytes, count(*) as count FROM executor_cache",
                )
                .one(),
            );
            if (totals.bytes > cacheLimits.totalBytes || totals.count > cacheLimits.totalEntries)
              throw new CacheError({ reason: "capacity" });
          };
          switch (command.operation) {
            case "read": {
              if (command.keys.length > cacheLimits.batchEntries)
                throw new CacheError({ reason: "capacity" });
              let bytes = 0;
              return command.keys.map((key) => {
                const row = read(key);
                if (row === undefined || row.value === null) return null;
                bytes += row.bytes;
                if (bytes > cacheLimits.batchBytes) throw new CacheError({ reason: "capacity" });
                return {
                  value: Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Json))(row.value),
                  version: row.version,
                  freshUntil: row.fresh,
                  staleUntil: row.stale,
                };
              });
            }
            case "claim": {
              const row = read(command.key);
              if (
                (row?.value === null ? null : (row?.version ?? null)) !== command.version ||
                (row !== undefined && row.lease_until > now)
              )
                return null;
              const lease = crypto.randomUUID();
              storage.sql.exec(
                `INSERT INTO executor_cache VALUES (?, ?, NULL, ?, 0, ?, ?, ?, 0, ?)
              ON CONFLICT(namespace, key) DO UPDATE SET lease=excluded.lease, lease_until=excluded.lease_until`,
                namespace,
                command.key,
                lease,
                now + cacheLimits.leaseMs,
                lease,
                now + cacheLimits.leaseMs,
                now,
              );
              bound();
              return lease;
            }
            case "publish": {
              const row = read(command.key);
              if (row?.lease !== command.lease || row.lease_until <= now) return false;
              write(command.key, command.entry);
              bound();
              return true;
            }
            case "write": {
              if (
                command.entries.length > cacheLimits.batchEntries ||
                new TextEncoder().encode(JSON.stringify(command.entries)).byteLength >
                  cacheLimits.batchBytes
              )
                throw new CacheError({ reason: "capacity" });
              for (const { key, entry } of command.entries) write(key, entry);
              bound();
              return null;
            }
            case "invalidate":
              // Revoke an in-flight publication as well as the retained value.
              storage.sql.exec(
                "DELETE FROM executor_cache WHERE namespace = ? AND key = ?",
                namespace,
                command.key,
              );
              return null;
            case "release":
              storage.sql.exec(
                "UPDATE executor_cache SET lease=NULL, lease_until=0 WHERE namespace=? AND key=? AND lease=?",
                namespace,
                command.key,
                command.lease,
              );
              return null;
          }
        });
      },
      catch: (error) =>
        error instanceof CacheError ? error : new CacheError({ reason: "storage" }),
    });
};
