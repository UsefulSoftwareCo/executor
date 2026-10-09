/**
 * Evaluated results kept in the app supervisor's SQLite, beside and separate from the app cache.
 * App code never reaches this table: it holds what the host evaluated, keyed by the host.
 */
import { Effect, Schema } from "effect";
import { EvaluatedCommand, evaluatedLimits } from "../contracts/evaluated.ts";

class EvaluatedStoreFailed extends Schema.TaggedError<EvaluatedStoreFailed>()(
  "EvaluatedStoreFailed",
  {},
) {}

/** The supervisor's synchronous SQL, which also binds and returns BLOBs as `ArrayBuffer`. */
export interface EvaluatedSqlStorage {
  readonly sql: {
    readonly exec: (
      query: string,
      ...bindings: (string | number | null | ArrayBuffer)[]
    ) => { readonly toArray: () => readonly unknown[]; readonly one: () => unknown };
  };
  readonly transactionSync: <A>(work: () => A) => A;
}

const At = Schema.Struct({ at: Schema.Number });
const Part = Schema.Struct({ at: Schema.Number, body: Schema.instanceOf(ArrayBuffer) });
const Changed = Schema.Struct({ changed: Schema.Number });
const Usage = Schema.Struct({ bytes: Schema.NullOr(Schema.Number) });

const initialize = (storage: EvaluatedSqlStorage) =>
  storage.transactionSync(() => {
    storage.sql.exec(`CREATE TABLE IF NOT EXISTS executor_evaluated (
      key TEXT NOT NULL, part INTEGER NOT NULL, at REAL NOT NULL, until REAL NOT NULL,
      body BLOB NOT NULL, bytes INTEGER NOT NULL, PRIMARY KEY(key, part)
    )`);
    storage.sql.exec(
      "CREATE INDEX IF NOT EXISTS executor_evaluated_until ON executor_evaluated(until)",
    );
    storage.sql.exec(`CREATE TABLE IF NOT EXISTS executor_evaluated_changes (
      id INTEGER PRIMARY KEY CHECK (id = 0), changed REAL NOT NULL
    )`);
  });

/**
 * One app's store. `changed` records an app cache invalidation: results evaluated no later than
 * then are neither served nor accepted, so every isolate forgets them at once.
 */
export const evaluatedStore = (storage: EvaluatedSqlStorage) => {
  let initialized = false;
  const ready = () => {
    if (initialized) return;
    initialize(storage);
    initialized = true;
  };
  const lastChange = () => {
    const row = storage.sql
      .exec("SELECT changed FROM executor_evaluated_changes WHERE id = 0")
      .toArray()[0];
    return row === undefined ? -Infinity : Schema.decodeUnknownSync(Changed)(row).changed;
  };
  return {
    changed: (at: number) =>
      Effect.try({
        try: () => {
          ready();
          storage.transactionSync(() => {
            storage.sql.exec(
              `INSERT INTO executor_evaluated_changes VALUES (0, ?)
              ON CONFLICT(id) DO UPDATE SET changed = max(changed, excluded.changed)`,
              at,
            );
            storage.sql.exec("DELETE FROM executor_evaluated WHERE at <= ?", at);
          });
        },
        catch: () => new EvaluatedStoreFailed(),
      }),
    command: (input: unknown) =>
      Effect.try({
        try: (): { readonly at: number; readonly body: Uint8Array } | null | boolean => {
          const command = Schema.decodeUnknownSync(EvaluatedCommand)(input);
          ready();
          const now = Date.now();
          return storage.transactionSync(() => {
            storage.sql.exec("DELETE FROM executor_evaluated WHERE until < ?", now);
            if (command.operation === "read") {
              const parts = storage.sql
                .exec(
                  "SELECT at, body FROM executor_evaluated WHERE key = ? ORDER BY part",
                  command.key,
                )
                .toArray()
                .map((row) => Schema.decodeUnknownSync(Part)(row));
              const first = parts[0];
              if (first === undefined || parts.some((part) => part.at !== first.at)) return null;
              const body = new Uint8Array(
                parts.reduce((total, part) => total + part.body.byteLength, 0),
              );
              let offset = 0;
              for (const part of parts) {
                body.set(new Uint8Array(part.body), offset);
                offset += part.body.byteLength;
              }
              return { at: first.at, body };
            }
            if (command.body.byteLength > evaluatedLimits.entryBytes) return false;
            if (command.at <= lastChange()) return false;
            // A newer result of the same key, written by another isolate, stays.
            const current = storage.sql
              .exec("SELECT at FROM executor_evaluated WHERE key = ? LIMIT 1", command.key)
              .toArray()[0];
            if (current !== undefined && Schema.decodeUnknownSync(At)(current).at > command.at)
              return false;
            storage.sql.exec("DELETE FROM executor_evaluated WHERE key = ?", command.key);
            for (
              let part = 0, offset = 0;
              offset < command.body.byteLength;
              part += 1, offset += evaluatedLimits.partBytes
            ) {
              const body = command.body.slice(offset, offset + evaluatedLimits.partBytes).buffer;
              storage.sql.exec(
                "INSERT INTO executor_evaluated VALUES (?, ?, ?, ?, ?, ?)",
                command.key,
                part,
                command.at,
                command.until,
                body,
                body.byteLength,
              );
            }
            // Over the bound, the results evaluated longest ago leave first.
            for (;;) {
              const usage = Schema.decodeUnknownSync(Usage)(
                storage.sql.exec("SELECT sum(bytes) AS bytes FROM executor_evaluated").one(),
              );
              if ((usage.bytes ?? 0) <= evaluatedLimits.totalBytes) break;
              storage.sql.exec(
                `DELETE FROM executor_evaluated WHERE key =
                (SELECT key FROM executor_evaluated ORDER BY at LIMIT 1)`,
              );
            }
            return true;
          });
        },
        catch: () => new EvaluatedStoreFailed(),
      }),
  };
};
