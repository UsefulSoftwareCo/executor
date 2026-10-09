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
const Usage = Schema.Struct({ bytes: Schema.Number, count: Schema.Number });

/**
 * Totals are kept by triggers, so bounding a write reads one row instead of every entry.
 * Stores created before the usage table are counted once, in the transaction that adds it.
 */
const initialize = (storage: CacheSqlStorage) =>
  storage.transactionSync(() => {
    storage.sql.exec(`CREATE TABLE IF NOT EXISTS executor_cache (
      namespace TEXT NOT NULL, key TEXT NOT NULL, value TEXT, version TEXT NOT NULL,
      fresh REAL NOT NULL, stale REAL NOT NULL, lease TEXT, lease_until REAL NOT NULL,
      bytes INTEGER NOT NULL, touched REAL NOT NULL, PRIMARY KEY(namespace, key)
    )`);
    storage.sql.exec("CREATE INDEX IF NOT EXISTS executor_cache_expiry ON executor_cache(stale)");
    storage.sql.exec(
      "CREATE INDEX IF NOT EXISTS executor_cache_oldest ON executor_cache(touched, namespace, key)",
    );
    storage.sql.exec(`CREATE TABLE IF NOT EXISTS executor_cache_usage (
      id INTEGER PRIMARY KEY CHECK (id = 0), bytes INTEGER NOT NULL, count INTEGER NOT NULL
    )`);
    if (storage.sql.exec("SELECT id FROM executor_cache_usage").toArray().length === 0)
      storage.sql.exec(
        "INSERT INTO executor_cache_usage SELECT 0, coalesce(sum(bytes), 0), count(*) FROM executor_cache",
      );
    storage.sql
      .exec(`CREATE TRIGGER IF NOT EXISTS executor_cache_inserted AFTER INSERT ON executor_cache
      BEGIN UPDATE executor_cache_usage SET bytes = bytes + NEW.bytes, count = count + 1 WHERE id = 0; END`);
    storage.sql
      .exec(`CREATE TRIGGER IF NOT EXISTS executor_cache_deleted AFTER DELETE ON executor_cache
      BEGIN UPDATE executor_cache_usage SET bytes = bytes - OLD.bytes, count = count - 1 WHERE id = 0; END`);
    storage.sql
      .exec(`CREATE TRIGGER IF NOT EXISTS executor_cache_resized AFTER UPDATE OF bytes ON executor_cache
      BEGIN UPDATE executor_cache_usage SET bytes = bytes - OLD.bytes + NEW.bytes WHERE id = 0; END`);
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
          initialize(storage);
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
          const entry = (row: typeof Row.Type | undefined): CacheEntry | null =>
            row === undefined || row.value === null
              ? null
              : {
                  value: Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Json))(row.value),
                  version: row.version,
                  freshUntil: row.fresh,
                  staleUntil: row.stale,
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
          const usage = () =>
            Schema.decodeUnknownSync(Usage)(
              storage.sql.exec("SELECT bytes, count FROM executor_cache_usage WHERE id = 0").one(),
            );
          const bound = (protectedKeys: readonly string[]) => {
            const totals = usage();
            if (totals.bytes <= cacheLimits.totalBytes && totals.count <= cacheLimits.totalEntries)
              return;
            // Reclaim in write-age order, not LRU: reads do not change touched. Leave room for
            // another batch so pressure does not scan victims on every small write. Live leases
            // and every entry this command installs are ineligible, even after publish clears its lease.
            const bytes =
              totals.bytes > cacheLimits.totalBytes
                ? totals.bytes - cacheLimits.totalBytes + cacheLimits.batchBytes
                : 0;
            const count =
              totals.count > cacheLimits.totalEntries
                ? totals.count - cacheLimits.totalEntries + cacheLimits.batchEntries
                : 0;
            storage.sql.exec(
              `WITH victims AS (
                SELECT rowid, bytes,
                  sum(bytes) OVER (ORDER BY touched, namespace, key) - bytes AS prior_bytes,
                  row_number() OVER (ORDER BY touched, namespace, key) - 1 AS prior_count
                FROM executor_cache
                WHERE lease_until <= ? AND NOT (namespace = ? AND key IN (SELECT value FROM json_each(?)))
                ORDER BY touched, namespace, key LIMIT ?
              )
              DELETE FROM executor_cache WHERE rowid IN (
                SELECT rowid FROM victims WHERE prior_bytes < ? OR prior_count < ?
              )`,
              now,
              namespace,
              JSON.stringify(protectedKeys),
              cacheLimits.totalEntries + cacheLimits.batchEntries,
              bytes,
              count,
            );
            const remaining = usage();
            // No safe victim can make this command fit. Roll back its writes and reclamation;
            // never remove a live fence or claim that an unretained direct write succeeded.
            if (
              remaining.bytes > cacheLimits.totalBytes ||
              remaining.count > cacheLimits.totalEntries
            )
              throw new CacheError({ reason: "capacity" });
          };
          const claim = (key: string) => {
            const lease = crypto.randomUUID();
            storage.sql.exec(
              `INSERT INTO executor_cache VALUES (?, ?, NULL, ?, 0, ?, ?, ?, 0, ?)
              ON CONFLICT(namespace, key) DO UPDATE SET lease=excluded.lease, lease_until=excluded.lease_until`,
              namespace,
              key,
              lease,
              now + cacheLimits.leaseMs,
              lease,
              now + cacheLimits.leaseMs,
              now,
            );
            bound([key]);
            return lease;
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
                return entry(row);
              });
            }
            case "acquire": {
              const row = read(command.key);
              const current = entry(row);
              const wanted =
                (command.version === undefined || (current?.version ?? null) === command.version) &&
                (command.refresh || current === null || now >= current.freshUntil);
              const lease =
                wanted && (row === undefined || row.lease_until <= now) ? claim(command.key) : null;
              return { entry: current, lease };
            }
            case "claim": {
              const row = read(command.key);
              if (
                (row?.value === null ? null : (row?.version ?? null)) !== command.version ||
                (row !== undefined && row.lease_until > now)
              )
                return null;
              return claim(command.key);
            }
            case "publish": {
              const row = read(command.key);
              if (row?.lease !== command.lease || row.lease_until <= now) return false;
              write(command.key, command.entry);
              bound([command.key]);
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
              bound(command.entries.map(({ key }) => key));
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
            case "renew": {
              const row = read(command.key);
              if (row?.lease !== command.lease || row.lease_until <= now) return false;
              storage.sql.exec(
                "UPDATE executor_cache SET lease_until=? WHERE namespace=? AND key=? AND lease=?",
                now + cacheLimits.leaseMs,
                namespace,
                command.key,
                command.lease,
              );
              return true;
            }
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
