/**
 * App-owned SQLite. An app with migrations in `migrations/` reads and writes its own database with
 * plain SQL. The author API mirrors Cloudflare's `SqlStorage`, so tools built for Durable Object
 * SQLite fit it.
 */

/** A value SQLite stores or returns. */
export type SqlValue = string | number | null | ArrayBuffer;
/** One result row, keyed by column name. */
export type SqlRow = Record<string, SqlValue>;

/** The rows of one statement, already read, and what the statement read and wrote. */
export interface SqlCursor<Row extends SqlRow = SqlRow> extends Iterable<Row> {
  readonly columnNames: readonly string[];
  readonly rowsRead: number;
  readonly rowsWritten: number;
  toArray(): Row[];
  /** The only row. Throws unless the statement returned exactly one. */
  one(): Row;
}

/**
 * Read-only SQL. Query tools receive this. A query runs in a transaction that is always rolled
 * back, so nothing it changes commits; one that changes rows fails.
 */
export interface SqlReader {
  exec<Row extends SqlRow = SqlRow>(query: string, ...bindings: SqlValue[]): SqlCursor<Row>;
}

/** SQL inside one transaction. */
export type SqlTransaction = SqlReader;

/**
 * Writable SQL. Outside a transaction every statement commits on its own. `transaction` runs its
 * callback synchronously in one SQLite transaction, so no transaction can stay open while the app
 * waits on anything else; throwing rolls it back. Apps call outside services between transactions.
 */
export interface Sql extends SqlReader {
  transaction<T>(work: (tx: SqlTransaction) => Synchronous<T>): T;
}

/** A transaction callback's result: a Promise means the callback awaited, which is refused. */
export type Synchronous<T> = T extends PromiseLike<unknown> ? never : T;

/** The Durable Object storage a data facet hands its app. App code never receives it. */
export interface AppSqlStorage {
  readonly sql: {
    exec(
      query: string,
      ...bindings: SqlValue[]
    ): {
      readonly columnNames: string[];
      readonly rowsRead: number;
      readonly rowsWritten: number;
      toArray(): Record<string, SqlValue>[];
    };
  };
  transactionSync<T>(work: () => T): T;
}

/**
 * Tables Executor keeps in an app's database: applied migrations, workflow step receipts, and
 * `_executor_legacy_rows (table_name, id, body)`, the rows of the document API apps used before
 * SQL, with JSON bodies (empty for apps that never stored any). Apps should only read them; a
 * changed migration history fails the next deploy.
 */
export const reservedTablePrefix = "_executor_";

/** Where an app keeps its migrations: `0001_create_notes.sql`, applied in number order. */
export const migrationsDirectory = "migrations";
