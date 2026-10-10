/**
 * `ctx.sql` over a data facet's SQLite storage, and the deploy-time migrator.
 *
 * Every statement runs inside a synchronous SQLite transaction: alone, or inside the author's
 * `transaction`. Nothing here can wait on another call, so no lock or transaction outlives the
 * statement that needs it. What a statement may do is decided by SQLite, not by reading the SQL:
 * a query runs in a transaction that is always rolled back.
 */
import { Effect, Schema } from "effect";
import {
  migrationsDirectory,
  reservedTablePrefix,
  sqlBindingsLimit,
  type AppSqlStorage,
  type Sql,
  type SqlCursor,
  type SqlReader,
  type SqlRow,
  type SqlValue,
} from "../contracts/sql.ts";
import type { SkillFile } from "../contracts/skills.ts";
import type { MigrateResult } from "../contracts/protocols/current.ts";

/** The receipt table of workflow step mutations. */
const receipts = `${reservedTablePrefix}step_receipts`;
/** The events a step's transaction emitted, restored when a retry replays its receipt. */
const stepEvents = `${reservedTablePrefix}step_events`;
/** Applied migrations: their order, file name and content hash. */
const migrationsTable = `${reservedTablePrefix}migrations`;
/**
 * The rows apps stored through the document API used before `sql`, one row per stored record with
 * its JSON body. Every app database has it, empty for apps that never used that API, so one
 * migration that copies old rows out works for upgraded and fresh deployments alike.
 */
const legacyRows = `${reservedTablePrefix}legacy_rows`;

/** Rows already read, so budgets are counted when the statement runs. */
const materialize = <Row extends SqlRow>(
  cursor: ReturnType<AppSqlStorage["sql"]["exec"]>,
): SqlCursor<Row> => {
  // SAFETY: SQLite returns plain rows of SqlValue; the author names the row type it selected.
  const rows = cursor.toArray() as Row[];
  return {
    columnNames: cursor.columnNames,
    rowsRead: cursor.rowsRead,
    rowsWritten: cursor.rowsWritten,
    toArray: () => [...rows],
    one: () => {
      if (rows.length !== 1)
        throw new Error(`Expected exactly one row, but the statement returned ${rows.length}.`);
      // SAFETY: the length check above guarantees the element.
      return rows[0] as Row;
    },
    [Symbol.iterator]: () => rows[Symbol.iterator](),
  };
};

const isThenable = (value: unknown): boolean =>
  (typeof value === "object" || typeof value === "function") &&
  value !== null &&
  "then" in value &&
  typeof value.then === "function";

/** `ctx.sql` of an app whose build has no migrations, and so no database. */
const missingDatabase = (): never => {
  throw new Error(
    `This app has no database. Add its first migration, such as ${migrationsDirectory}/0001_create_notes.sql with a CREATE TABLE statement, and deploy again.`,
  );
};
export const noDatabase: Sql = { exec: missingDatabase, transaction: missingDatabase };

/** A workflow step mutation's identity, from the host's replay record. */
export interface StepReplay {
  readonly key: string;
  readonly fingerprint: string;
}

/**
 * The SQLite connection settings app SQL can change. They belong to Executor: a transaction does
 * not roll them back, so a query or a failed statement could otherwise change how every later
 * call behaves (`ignore_check_constraints` turns off CHECK constraints). Durable Objects run each
 * `transactionSync` as a savepoint, so even `defer_foreign_keys` outlives one. A statement that
 * leaves one changed fails and rolls back. `case_sensitive_like` cannot be read, so it is reset to
 * SQLite's default instead.
 */
const settings = [
  "foreign_keys",
  "defer_foreign_keys",
  "ignore_check_constraints",
  "legacy_alter_table",
  "recursive_triggers",
  "reverse_unordered_selects",
] as const;
type Settings = ReadonlyMap<(typeof settings)[number], number>;

const readSettings = (storage: AppSqlStorage): Settings =>
  new Map(
    settings.map((name) => [name, Number(storage.sql.exec(`PRAGMA ${name}`).toArray()[0]?.[name])]),
  );

/** The first setting that differs from `baseline`. */
const changedSetting = (storage: AppSqlStorage, baseline: Settings) => {
  const current = readSettings(storage);
  return settings.find((name) => current.get(name) !== baseline.get(name));
};

/** Put every setting back. */
const restoreSettings = (storage: AppSqlStorage, baseline: Settings) => {
  const current = readSettings(storage);
  for (const [name, value] of baseline)
    if (current.get(name) !== value) storage.sql.exec(`PRAGMA ${name} = ${value}`);
  storage.sql.exec("PRAGMA case_sensitive_like = OFF");
};

/** Thrown to roll back a read's transaction after its rows are read. */
class ReadRolledBack extends Error {}

/**
 * One invocation's SQL. Once the invocation ends or `signal` aborts, every statement is refused, so
 * code still running after a timeout or cancellation cannot write late.
 */
export const authorSql = (
  storage: AppSqlStorage,
  options: {
    readonly signal: AbortSignal;
    readonly step?: StepReplay;
    /**
     * The invocation's emitted events. A transaction that rolls back also discards the events its
     * callback emitted, so subscribers never hear of writes that did not commit.
     */
    readonly emitted?: unknown[];
  },
) => {
  let closed = false;
  const live = () => {
    if (closed || options.signal.aborted)
      throw new Error("This call has ended, so its ctx.sql no longer runs statements.");
  };
  let open = false;
  let transactions = 0;
  const baseline = readSettings(storage);
  /** Checked inside the statement's transaction, so a refused statement's writes roll back. */
  const checkSettings = () => {
    const changed = changedSetting(storage, baseline);
    if (changed !== undefined)
      throw refuse(
        new Error(
          `SQLite connection settings belong to Executor, so app code cannot change PRAGMA ${changed}; the statement was rolled back. Migrations may change settings while they run.`,
        ),
      );
  };
  const changes = () => Number(storage.sql.exec("SELECT total_changes() AS n").toArray()[0]?.n);
  /** A statement that failed inside a transaction fails the whole transaction, even if caught. */
  let violation: Error | undefined;
  const refuse = (error: Error) => {
    if (open) violation ??= error;
    return error;
  };
  /** Run one statement; afterwards every connection setting is Executor's again. */
  const run = <Row extends SqlRow>(
    query: string,
    bindings: readonly SqlValue[],
    mode: "read" | "write",
  ): SqlCursor<Row> => {
    try {
      return runStatement<Row>(query, bindings, mode);
    } finally {
      restoreSettings(storage, baseline);
    }
  };
  /** A throw inside `transactionSync` rolls the statement back. */
  const runStatement = <Row extends SqlRow>(
    query: string,
    bindings: readonly SqlValue[],
    mode: "read" | "write",
  ): SqlCursor<Row> => {
    live();
    if (bindings.length > sqlBindingsLimit)
      throw refuse(
        new Error(
          `A statement can bind at most ${sqlBindingsLimit} values, but this one binds ${bindings.length}. Pass a long list as one JSON array and read it with json_each(?), or split the work into batches.`,
        ),
      );
    if (mode === "write") {
      const statement = () => {
        const cursor = materialize<Row>(storage.sql.exec(query, ...bindings));
        checkSettings();
        return cursor;
      };
      if (!open) return storage.transactionSync(statement);
      // A statement that fails inside a transaction fails the transaction, even if the app
      // catches the error: a failed statement can leave partial changes, as `INSERT OR FAIL` does.
      try {
        return statement();
      } catch (error) {
        refuse(error instanceof Error ? error : new Error(String(error)));
        throw error;
      }
    }
    if (open) {
      // Inside a transaction a read is an ordinary statement of it; the transaction's own
      // rules decide whether it commits.
      return runStatement(query, bindings, "write");
    }
    // A read runs in a transaction that is always rolled back, so whatever it would have
    // changed, rows or schema, never commits. SQLite's own count of changed rows explains why.
    const before = changes();
    let read: SqlCursor<Row> | undefined;
    let changed = false;
    try {
      storage.transactionSync(() => {
        read = materialize<Row>(storage.sql.exec(query, ...bindings));
        changed = changes() !== before;
        checkSettings();
        throw new ReadRolledBack();
      });
    } catch (error) {
      if (!(error instanceof ReadRolledBack)) throw error;
    }
    if (changed || read === undefined)
      throw new Error(
        options.step !== undefined
          ? "A workflow step mutation writes only inside ctx.sql.transaction(...), so a retried step applies its writes once."
          : "Queries are read-only. Change data from a mutation.",
      );
    return read;
  };
  const reader: SqlReader = {
    exec: (query, ...bindings) => run(query, bindings, "read"),
  };
  /** One transaction's statements. Its `tx` refuses statements once the callback has returned. */
  const transactionHandle = () => {
    let active = true;
    const tx: SqlReader = {
      exec: (query, ...bindings) => {
        if (!active)
          throw new Error("This transaction has ended, so its tx no longer runs statements.");
        return run(query, bindings, "write");
      },
    };
    return {
      tx,
      end: () => {
        active = false;
      },
    };
  };
  const transaction = <T>(work: (tx: SqlReader) => T): T => {
    live();
    if (open) throw new Error("ctx.sql.transaction(...) cannot be nested.");
    const step = options.step;
    if (step !== undefined && transactions > 0)
      throw new Error(
        "A workflow step mutation opens at most one ctx.sql.transaction(...), which records the step's result.",
      );
    transactions += 1;
    violation = undefined;
    const handle = transactionHandle();
    const emittedBefore = options.emitted?.length;
    const discardEmitted = () => {
      if (options.emitted !== undefined && emittedBefore !== undefined)
        options.emitted.length = emittedBefore;
    };
    const body = () => {
      open = true;
      try {
        const complete = () => {
          const value = work(handle.tx);
          // An async callback would commit what ran before its first await; refuse it whole.
          if (isThenable(value))
            throw new Error(
              "ctx.sql.transaction(...) callbacks are synchronous and cannot await. Call outside services before or after the transaction.",
            );
          // A failed statement inside the callback rolls the transaction back, even if it was
          // caught.
          if (violation !== undefined) throw violation;
          return value;
        };
        if (step === undefined) return complete();
        storage.sql.exec(
          `CREATE TABLE IF NOT EXISTS ${receipts} (id TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, result TEXT NOT NULL) WITHOUT ROWID`,
        );
        const saved = storage.sql
          .exec(`SELECT fingerprint, result FROM ${receipts} WHERE id = ?`, step.key)
          .toArray()[0];
        storage.sql.exec(
          `CREATE TABLE IF NOT EXISTS ${stepEvents} (id TEXT PRIMARY KEY, events TEXT NOT NULL) WITHOUT ROWID`,
        );
        if (saved !== undefined) {
          if (saved.fingerprint !== step.fingerprint)
            throw new Error("This workflow step already ran with different input.");
          // A retry after its events could not be saved emits them again, with their IDs.
          const replayed = storage.sql
            .exec(`SELECT events FROM ${stepEvents} WHERE id = ?`, step.key)
            .toArray()[0];
          if (replayed !== undefined && options.emitted !== undefined)
            options.emitted.push(...(JSON.parse(String(replayed.events)) as unknown[]));
          // SAFETY: the receipt holds what this transaction returned, encoded below.
          return JSON.parse(String(saved.result)) as T;
        }
        const encoded = JSON.stringify(complete() ?? null);
        const emitted = options.emitted?.slice(emittedBefore ?? 0) ?? [];
        if (emitted.length > 0)
          storage.sql.exec(
            `INSERT INTO ${stepEvents} (id, events) VALUES (?, ?)`,
            step.key,
            JSON.stringify(emitted),
          );
        storage.sql.exec(
          `INSERT INTO ${receipts} (id, fingerprint, result) VALUES (?, ?, ?)`,
          step.key,
          step.fingerprint,
          encoded,
        );
        // A step returns its result as JSON on every attempt, so a replay matches the first run.
        // SAFETY: the receipt holds what this transaction returned, encoded above.
        return JSON.parse(encoded) as T;
      } finally {
        open = false;
        handle.end();
      }
    };
    // A failure anywhere, including at commit, rolls back the writes and the events with them.
    try {
      return storage.transactionSync(body);
    } catch (error) {
      discardEmitted();
      throw error;
    }
  };
  const writer: Sql = {
    // A step's writes go through its one transaction, which also records its receipt.
    exec: (query, ...bindings) => run(query, bindings, options.step ? "read" : "write"),
    transaction,
  };
  return {
    reader,
    writer,
    close: () => {
      closed = true;
    },
  };
};

/** A file in `migrations/` that is not a migration the host can order. */
export class MigrationFileInvalid extends Schema.TaggedError<MigrationFileInvalid>()(
  "MigrationFileInvalid",
  { path: Schema.String, reason: Schema.String },
) {
  override get message() {
    return `${this.path}: ${this.reason}`;
  }
}

/** The build's migrations no longer start with the ones already applied to the database. */
export class MigrationHistoryChanged extends Schema.TaggedError<MigrationHistoryChanged>()(
  "MigrationHistoryChanged",
  { reason: Schema.String },
) {
  override get message() {
    return `${this.reason} Applied migrations cannot change: restore the original file and add a new migration instead. Nothing was applied; the previous deployment is still active.`;
  }
}

/** SQLite rejected a migration. Every migration of the deploy rolled back. */
export class MigrationFailed extends Schema.TaggedError<MigrationFailed>()("MigrationFailed", {
  path: Schema.String,
  reason: Schema.String,
}) {
  override get message() {
    return `${this.path} failed: ${this.reason}. No migrations were applied; the previous deployment is still active.`;
  }
}

/** `0001_create_notes.sql`: a number that orders it, then a name. */
const migrationName = /^(\d+)_[A-Za-z0-9_-]+\.sql$/;

interface Migration {
  readonly path: string;
  readonly order: number;
  readonly content: string;
  readonly hash: string;
}

const sha256 = (text: string) =>
  // oxlint-disable-next-line executor/authored-code-through-adapter -- Web Crypto
  Effect.promise(() => crypto.subtle.digest("SHA-256", new TextEncoder().encode(text))).pipe(
    Effect.map((digest) =>
      Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join(""),
    ),
  );

/**
 * A script up to the end of its last statement. Durable Object SQLite refuses a script whose last
 * statement is followed by a comment ("SQL code did not contain a statement"), so the comments and
 * whitespace after it are not run. Quoted text and identifiers may contain `--` and `/*`.
 */
const statementsOf = (script: string) => {
  let end = 0;
  let index = 0;
  while (index < script.length) {
    const char = script[index];
    const next = script[index + 1];
    if (char === "-" && next === "-") {
      const newline = script.indexOf("\n", index);
      index = newline === -1 ? script.length : newline + 1;
      continue;
    }
    if (char === "/" && next === "*") {
      const close = script.indexOf("*/", index + 2);
      index = close === -1 ? script.length : close + 2;
      continue;
    }
    const closing =
      char === "'" || char === '"' || char === "`" ? char : char === "[" ? "]" : undefined;
    if (closing !== undefined) {
      // A doubled quote is an escaped quote; an unterminated one runs to the end, as SQLite reads it.
      let after = index + 1;
      while (true) {
        const found = script.indexOf(closing, after);
        if (found === -1) {
          after = script.length;
          break;
        }
        if (closing !== "]" && script[found + 1] === closing) {
          after = found + 2;
          continue;
        }
        after = found + 1;
        break;
      }
      index = after;
      end = index;
      continue;
    }
    index += 1;
    if (char !== undefined && !/\s/u.test(char)) end = index;
  }
  return script.slice(0, end);
};

/** Whether a build's files give the app a database: any `.sql` file in `migrations/`. */
export const hasMigrations = (files: readonly { readonly path: string }[]) =>
  files.some(
    (file) => file.path.startsWith(`${migrationsDirectory}/`) && file.path.endsWith(".sql"),
  );

/** The build's migrations, ordered by their number. Line endings do not change a hash. */
const migrationsOf = (files: readonly SkillFile[]) =>
  Effect.gen(function* () {
    const found: Migration[] = [];
    for (const file of files) {
      if (!file.path.startsWith(`${migrationsDirectory}/`) || !file.path.endsWith(".sql")) continue;
      const name = file.path.slice(migrationsDirectory.length + 1);
      const match = migrationName.exec(name);
      if (name.includes("/") || match === null)
        return yield* new MigrationFileInvalid({
          path: file.path,
          reason:
            "migrations are files directly in migrations/ named like 0001_create_notes.sql: a number that orders them, an underscore, then a name.",
        });
      const content = file.content.replaceAll("\r\n", "\n");
      found.push({
        path: file.path,
        order: Number(match[1]),
        content,
        hash: yield* sha256(content),
      });
    }
    const ordered = [...found].sort((left, right) => left.order - right.order);
    for (const [index, migration] of ordered.entries()) {
      const previous = ordered[index - 1];
      if (previous !== undefined && previous.order === migration.order)
        return yield* new MigrationFileInvalid({
          path: migration.path,
          reason: `it has the same number as ${previous.path}; give each migration its own number.`,
        });
    }
    return ordered;
  });

const History = Schema.Array(
  Schema.Struct({ id: Schema.Number, path: Schema.String, hash: Schema.String }),
);

/**
 * Apply the build's pending migrations and report which ran. Every pending migration runs in one
 * transaction, so a failing one leaves the database exactly as the active deployment knows it. The
 * migrations already applied must still be the build's first ones, byte for byte.
 */
export const migrate = (storage: AppSqlStorage, files: readonly SkillFile[]) =>
  Effect.gen(function* () {
    const migrations = yield* migrationsOf(files);
    // A migration may change connection settings while it runs, for example turning off foreign
    // keys to rebuild a table; whatever happens, they are Executor's again afterwards.
    const baseline = readSettings(storage);
    return yield* Effect.sync(() =>
      storage.transactionSync(() => {
        storage.sql.exec(
          `CREATE TABLE IF NOT EXISTS ${migrationsTable} (id INTEGER PRIMARY KEY, path TEXT NOT NULL, hash TEXT NOT NULL, applied_at TEXT NOT NULL)`,
        );
        // Rebuilt on every run: a retained older build may have created `app_rows` since.
        const stored =
          storage.sql
            .exec("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'app_rows'")
            .toArray().length > 0;
        storage.sql.exec(`DROP VIEW IF EXISTS ${legacyRows}`);
        storage.sql.exec(
          `CREATE VIEW ${legacyRows} (table_name, id, body) AS ${
            stored ? "SELECT table_name, id, body FROM app_rows" : "SELECT '', '', '' WHERE 0"
          }`,
        );
        const history = Schema.decodeUnknownSync(History)(
          storage.sql.exec(`SELECT id, path, hash FROM ${migrationsTable} ORDER BY id`).toArray(),
        );
        for (const [index, applied] of history.entries()) {
          const current = migrations[index];
          if (current === undefined)
            throw new MigrationHistoryChanged({
              reason: `${applied.path} was applied to this app's database but is no longer in migrations/.`,
            });
          if (current.path !== applied.path)
            throw new MigrationHistoryChanged({
              reason: `Migration ${index + 1} was applied as ${applied.path}, but the build has ${current.path} in its place.`,
            });
          if (current.hash !== applied.hash)
            throw new MigrationHistoryChanged({
              reason: `${applied.path} changed after it was applied to this app's database.`,
            });
        }
        const pending = migrations.slice(history.length);
        const appliedAt = new Date().toISOString();
        for (const [offset, migration] of pending.entries()) {
          // The hash covers the whole file; only the statements run. A file of only comments
          // runs nothing.
          const statements = statementsOf(migration.content);
          try {
            if (statements !== "") storage.sql.exec(statements);
          } catch (error) {
            // Throwing rolls back every migration of this run.
            throw new MigrationFailed({
              path: migration.path,
              reason: error instanceof Error ? error.message : String(error),
            });
          }
          storage.sql.exec(
            `INSERT INTO ${migrationsTable} (id, path, hash, applied_at) VALUES (?, ?, ?, ?)`,
            history.length + offset + 1,
            migration.path,
            migration.hash,
            appliedAt,
          );
        }
        return pending.map((migration, offset): MigrateResult[number] => ({
          id: history.length + offset + 1,
          name: migration.path,
        }));
      }),
    ).pipe(
      // Both are thrown inside the transaction so that it rolls back; they are expected failures.
      Effect.catchDefect((defect) =>
        Schema.is(MigrationFailed)(defect) || Schema.is(MigrationHistoryChanged)(defect)
          ? Effect.fail(defect)
          : Effect.die(defect),
      ),
      Effect.ensuring(Effect.sync(() => restoreSettings(storage, baseline))),
    );
  });
