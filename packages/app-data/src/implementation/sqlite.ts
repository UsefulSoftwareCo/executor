/** Shared SQLite engine. Drivers, persistent paths and app ownership belong to the host. */
import { Clock, Effect, Encoding, Schema, Semaphore } from "effect";
import type { SqlClient } from "effect/unstable/sql/SqlClient";
import {
  AppDatabaseError,
  DatabaseLimits,
  DatabaseOperation,
  Row,
  RowMetadata,
  defaultDatabaseLimits,
  type AppDatabase,
  type DatabaseSession,
  type OperationResult,
  type Table,
} from "../contracts/database.ts";
import { canonicalSchema, indexesFor, parseDatabaseSchema, writeValue } from "./schema.ts";
import { cursorCodec, fingerprint } from "./cursor.ts";
import { encodeIndexKey } from "./index-key.ts";
import { queryBounds } from "./range.ts";

const Saved = Schema.Struct({ schema_hash: Schema.String, cursor_key: Schema.String });
const StoredRow = Schema.Struct({ body: Schema.String });
const ScanRow = Schema.Struct({ sort_key: Schema.Uint8Array, body: Schema.String });
const CountRow = Schema.Struct({ sort_key: Schema.Uint8Array });
const decodeRows = Schema.decodeUnknownEffect(Schema.Array(StoredRow));
const decodeBody = Schema.decodeUnknownEffect(Schema.fromJsonString(Row));
const storageError = () => new AppDatabaseError({ reason: "storage" });

/** Open a database whose storage is owned by exactly one configured app. Schema changes fail closed. */
export const makeSqliteDatabase = (options: {
  readonly sql: SqlClient;
  readonly schema: unknown;
  readonly crypto: Crypto;
  readonly limits?: DatabaseLimits;
}): Effect.Effect<AppDatabase, AppDatabaseError> =>
  Effect.gen(function* () {
    const { sql, crypto } = options;
    const schema = yield* parseDatabaseSchema(options.schema);
    const limits = yield* Schema.decodeUnknownEffect(DatabaseLimits)(
      options.limits ?? defaultDatabaseLimits,
    ).pipe(Effect.mapError(() => new AppDatabaseError({ reason: "limit" })));
    const schemaHash = yield* fingerprint(crypto, canonicalSchema(schema));
    const key = yield* sql
      .withTransaction(
        Effect.gen(function* () {
          yield* sql`CREATE TABLE IF NOT EXISTS app_database (singleton INTEGER PRIMARY KEY CHECK (singleton = 1), schema_hash TEXT NOT NULL, cursor_key TEXT NOT NULL)`;
          yield* sql`CREATE TABLE IF NOT EXISTS app_rows (table_name TEXT NOT NULL, id TEXT NOT NULL, body TEXT NOT NULL, PRIMARY KEY (table_name, id)) WITHOUT ROWID`;
          yield* sql`CREATE TABLE IF NOT EXISTS app_indexes (table_name TEXT NOT NULL, index_name TEXT NOT NULL, sort_key BLOB NOT NULL, row_id TEXT NOT NULL, PRIMARY KEY (table_name, index_name, sort_key)) WITHOUT ROWID`;
          yield* sql`CREATE TABLE IF NOT EXISTS app_mutation_receipts (id TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, result TEXT NOT NULL) WITHOUT ROWID`;
          yield* sql`CREATE INDEX IF NOT EXISTS app_indexes_by_row ON app_indexes (table_name, row_id)`;
          const generated = Encoding.encodeBase64Url(crypto.getRandomValues(new Uint8Array(32)));
          yield* sql`INSERT OR IGNORE INTO app_database (singleton, schema_hash, cursor_key) VALUES (1, ${schemaHash}, ${generated})`;
          const saved =
            yield* sql`SELECT schema_hash, cursor_key FROM app_database WHERE singleton = 1`.pipe(
              Effect.flatMap((rows) => Schema.decodeUnknownEffect(Saved)(rows[0])),
            );
          if (saved.schema_hash !== schemaHash)
            return yield* new AppDatabaseError({ reason: "schema_changed" });
          return yield* Effect.fromResult(Encoding.decodeBase64Url(saved.cursor_key));
        }),
      )
      .pipe(
        Effect.catchTags({
          SqlError: () => Effect.fail(storageError()),
          SchemaError: () => Effect.fail(storageError()),
          EncodingError: () => Effect.fail(storageError()),
        }),
      );
    const cursors = yield* cursorCodec(crypto, key);

    const run = <A, E, R>(
      writable: boolean,
      work: (session: DatabaseSession) => Effect.Effect<A, E, R>,
    ): Effect.Effect<A, E | AppDatabaseError, R> =>
      sql
        .withTransaction(
          Effect.gen(function* () {
            // Promise author calls re-enter Effect; retain this exact native transaction context.
            const context = yield* Effect.context<never>();
            const gate = yield* Semaphore.make(1);
            const reads = new Set<string>();
            const changes = new Set<string>();
            let active = true;
            let failed: AppDatabaseError | undefined;
            const used = {
              rowsRead: 0,
              rowsReturned: 0,
              bytesRead: 0,
              writes: 0,
              scanCalls: 0,
              directGets: 0,
            };
            const charge = (name: keyof typeof used, amount: number) =>
              Effect.suspend(() => {
                used[name] += amount;
                return used[name] > limits[name]
                  ? Effect.fail(new AppDatabaseError({ reason: "limit" }))
                  : Effect.void;
              });
            const get = (table: string, id: string) =>
              Effect.gen(function* () {
                yield* charge("directGets", 1);
                reads.add(table);
                const records =
                  yield* sql`SELECT body FROM app_rows WHERE table_name = ${table} AND id = ${id}`.pipe(
                    Effect.flatMap(decodeRows),
                  );
                const record = records[0];
                if (record === undefined) return null;
                yield* charge("rowsRead", 1);
                yield* charge("bytesRead", new TextEncoder().encode(record.body).length);
                return yield* decodeBody(record.body);
              });
            const store = (tableName: string, table: Table, row: Row) =>
              Effect.gen(function* () {
                const meta = yield* Schema.decodeUnknownEffect(RowMetadata)(row);
                const body = JSON.stringify(row);
                if (new TextEncoder().encode(body).length > limits.valueBytes)
                  return yield* new AppDatabaseError({ reason: "limit" });
                // Encode all index keys before the first write. Failure also poisons the outer mutation.
                const keys = yield* Effect.forEach(indexesFor(table), (index) =>
                  encodeIndexKey(
                    index.fields.map((field) =>
                      Object.hasOwn(row, field) ? (row[field] ?? null) : null,
                    ),
                    limits.indexBytes,
                  ).pipe(Effect.map((key) => ({ name: index.name, key }))),
                );
                yield* sql`INSERT INTO app_rows (table_name, id, body) VALUES (${tableName}, ${meta.id}, ${body}) ON CONFLICT(table_name, id) DO UPDATE SET body = excluded.body`;
                yield* sql`DELETE FROM app_indexes WHERE table_name = ${tableName} AND row_id = ${meta.id}`;
                for (const index of keys)
                  yield* sql`INSERT INTO app_indexes (table_name, index_name, sort_key, row_id) VALUES (${tableName}, ${index.name}, ${index.key}, ${meta.id})`;
                changes.add(tableName);
                return row;
              });
            const execute = (
              input: DatabaseOperation,
            ): Effect.Effect<OperationResult, AppDatabaseError> =>
              gate.withPermits(1)(
                Effect.gen(function* () {
                  if (!active) return yield* new AppDatabaseError({ reason: "closed" });
                  if (failed !== undefined) return yield* failed;
                  const operation = yield* Schema.decodeUnknownEffect(DatabaseOperation)(
                    input,
                  ).pipe(Effect.mapError(() => new AppDatabaseError({ reason: "value" })));
                  const tableName =
                    operation.kind === "query" ? operation.plan.table : operation.table;
                  const table = Object.hasOwn(schema, tableName) ? schema[tableName] : undefined;
                  if (table === undefined) return yield* new AppDatabaseError({ reason: "table" });
                  switch (operation.kind) {
                    case "get": {
                      const row = yield* get(tableName, operation.id);
                      if (row !== null) yield* charge("rowsReturned", 1);
                      return row;
                    }
                    case "insert": {
                      if (!writable) return yield* new AppDatabaseError({ reason: "readonly" });
                      yield* charge("writes", 1);
                      const timestamp = new Date(yield* Clock.currentTimeMillis).toISOString();
                      const row = yield* writeValue(table, operation.value, undefined, {
                        id: crypto.randomUUID(),
                        createdAt: timestamp,
                        updatedAt: timestamp,
                      });
                      return yield* store(tableName, table, row);
                    }
                    case "update": {
                      if (!writable) return yield* new AppDatabaseError({ reason: "readonly" });
                      yield* charge("writes", 1);
                      const before = yield* get(tableName, operation.id);
                      if (before === null) return null;
                      const meta = yield* Schema.decodeUnknownEffect(RowMetadata)(before);
                      const row = yield* writeValue(table, operation.patch, before, {
                        ...meta,
                        updatedAt: new Date(yield* Clock.currentTimeMillis).toISOString(),
                      });
                      return yield* store(tableName, table, row);
                    }
                    case "delete": {
                      if (!writable) return yield* new AppDatabaseError({ reason: "readonly" });
                      yield* charge("writes", 1);
                      const before = yield* get(tableName, operation.id);
                      if (before === null) return false;
                      yield* sql`DELETE FROM app_rows WHERE table_name = ${tableName} AND id = ${operation.id}`;
                      yield* sql`DELETE FROM app_indexes WHERE table_name = ${tableName} AND row_id = ${operation.id}`;
                      changes.add(tableName);
                      return true;
                    }
                    case "query": {
                      const { plan, terminal } = operation;
                      const bounds = yield* queryBounds(table, plan, limits.indexBytes);
                      reads.add(tableName);
                      yield* charge("scanCalls", 1);
                      const maximum =
                        terminal.kind === "count"
                          ? limits.rowsRead - used.rowsRead
                          : limits.rowsReturned - used.rowsReturned;
                      const count =
                        terminal.kind === "first"
                          ? 1
                          : terminal.kind === "take"
                            ? terminal.count
                            : terminal.kind === "paginate"
                              ? terminal.numItems
                              : maximum;
                      if (count > maximum) return yield* new AppDatabaseError({ reason: "limit" });
                      if (count === 0 && terminal.kind === "take") return [];
                      const query = yield* fingerprint(
                        crypto,
                        JSON.stringify({
                          schemaHash,
                          table: tableName,
                          index: plan.index,
                          order: plan.order,
                          lower: Encoding.encodeBase64Url(bounds.lower),
                          upper:
                            bounds.upper === undefined
                              ? null
                              : Encoding.encodeBase64Url(bounds.upper),
                        }),
                      );
                      const position =
                        terminal.kind === "paginate" && terminal.cursor !== null
                          ? yield* cursors.decode(query, terminal.cursor)
                          : undefined;
                      const predicates = [
                        sql`i.table_name = ${tableName}`,
                        sql`i.index_name = ${plan.index}`,
                        sql`i.sort_key >= ${bounds.lower}`,
                      ];
                      if (bounds.upper !== undefined)
                        predicates.push(sql`i.sort_key < ${bounds.upper}`);
                      if (position !== undefined)
                        predicates.push(
                          plan.order === "asc"
                            ? sql`i.sort_key > ${position}`
                            : sql`i.sort_key < ${position}`,
                        );
                      const direction =
                        plan.order === "asc" ? sql.literal("ASC") : sql.literal("DESC");
                      // One look-ahead entry distinguishes an exact bound from silent truncation.
                      const limit =
                        terminal.kind === "first" || terminal.kind === "take" ? count : count + 1;
                      if (terminal.kind === "count") {
                        const rows =
                          yield* sql`SELECT i.sort_key FROM app_indexes i WHERE ${sql.and(predicates)} ORDER BY i.sort_key ${direction} LIMIT ${limit}`.pipe(
                            Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(CountRow))),
                          );
                        yield* charge("rowsRead", rows.length);
                        yield* charge(
                          "bytesRead",
                          rows.reduce((sum, row) => sum + row.sort_key.byteLength, 0),
                        );
                        return rows.length;
                      }
                      const rows =
                        yield* sql`SELECT i.sort_key, r.body FROM app_indexes i JOIN app_rows r ON r.table_name = i.table_name AND r.id = i.row_id WHERE ${sql.and(predicates)} ORDER BY i.sort_key ${direction} LIMIT ${limit}`.pipe(
                          Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(ScanRow))),
                        );
                      yield* charge("rowsRead", rows.length);
                      yield* charge(
                        "bytesRead",
                        rows.reduce(
                          (sum, row) =>
                            sum +
                            new TextEncoder().encode(row.body).length +
                            row.sort_key.byteLength,
                          0,
                        ),
                      );
                      if (terminal.kind === "collect" && rows.length > count)
                        return yield* new AppDatabaseError({ reason: "limit" });
                      const page = rows.slice(0, count);
                      yield* charge("rowsReturned", page.length);
                      const values = yield* Effect.forEach(page, (row) => decodeBody(row.body));
                      if (terminal.kind === "first") return values[0] ?? null;
                      if (terminal.kind !== "paginate") return values;
                      const last = page.at(-1);
                      const isDone = rows.length <= count;
                      return {
                        page: values,
                        isDone,
                        continueCursor:
                          isDone || last === undefined
                            ? null
                            : yield* cursors.encode(query, last.sort_key),
                      };
                    }
                  }
                }).pipe(
                  Effect.catchTags({
                    SqlError: () => Effect.fail(storageError()),
                    SchemaError: () => Effect.fail(storageError()),
                  }),
                  Effect.tapError((error) =>
                    Effect.sync(() => {
                      failed = error;
                    }),
                  ),
                  Effect.provideContext(context),
                ),
              );
            const session: DatabaseSession = {
              readTables: reads,
              changedTables: changes,
              execute,
              once: (key, expected, work) =>
                Effect.gen(function* () {
                  if (!active) return yield* new AppDatabaseError({ reason: "closed" });
                  if (!writable) return yield* new AppDatabaseError({ reason: "readonly" });
                  const rows =
                    yield* sql`SELECT fingerprint, result FROM app_mutation_receipts WHERE id = ${key}`.pipe(
                      Effect.flatMap(
                        Schema.decodeUnknownEffect(
                          Schema.Array(
                            Schema.Struct({ fingerprint: Schema.String, result: Schema.String }),
                          ),
                        ),
                      ),
                      Effect.mapError(storageError),
                    );
                  const saved = rows[0];
                  if (saved !== undefined) {
                    if (saved.fingerprint !== expected)
                      return yield* new AppDatabaseError({ reason: "replay" });
                    return yield* Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Json))(
                      saved.result,
                    ).pipe(Effect.mapError(storageError));
                  }
                  const result = yield* work();
                  const encoded = yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Json))(
                    result,
                  ).pipe(Effect.mapError(storageError));
                  if (new TextEncoder().encode(encoded).byteLength > 1024 * 1024)
                    return yield* new AppDatabaseError({ reason: "limit" });
                  yield* sql`INSERT INTO app_mutation_receipts (id, fingerprint, result) VALUES (${key}, ${expected}, ${encoded})`.pipe(
                    Effect.mapError(storageError),
                  );
                  return result;
                }),
            };
            return yield* Effect.suspend(() => work(session)).pipe(
              Effect.tap(() =>
                gate.withPermits(1)(
                  Effect.suspend(() => (failed === undefined ? Effect.void : Effect.fail(failed))),
                ),
              ),
              Effect.ensuring(
                Effect.sync(() => {
                  active = false;
                }),
              ),
            );
          }),
        )
        .pipe(Effect.catchTag("SqlError", () => Effect.fail(storageError())));
    return {
      schema,
      schemaHash,
      read: (work) => run(false, work),
      mutate: (work) => run(true, work),
    };
  });
