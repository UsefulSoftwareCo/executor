/**
 * The SQL migrator, against real databases.
 *
 * The first tests are a port of upstream fumadb's
 * "generate migration: $provider using $mode". They replay the four schema
 * versions, each under a different table-name prefix, and compare the
 * generated script with the SQL Kysely produced upstream, in both
 * `from-schema` and `from-database` mode.
 */
import { Effect, Option, Result, Schema } from "effect";
import { SqlClient } from "effect/unstable/sql";
import * as fs from "node:fs";
import * as path from "node:path";
import { expect, test } from "vitest";
import { MigrationError } from "../src/contracts/errors.ts";
import { fumadb } from "../src/index.ts";
import type { MigrationOperation } from "../src/contracts/migration-operation.ts";
import type { Provider } from "../src/contracts/provider.ts";
import { column, idColumn, schema, table } from "../src/schema.ts";
import { quoteIdentifier } from "../src/implementation/sql/ddl.ts";
import { sqlAdapter } from "../src/implementation/sql/index.ts";
import { databaseName, providers, withProvider } from "./support/databases.ts";
import { normalizeMigrationSql } from "./support/inspect.ts";
import { migrateV1, migrateV2, migrateV3, migrateV4 } from "./support/schemas.ts";

const TestDB = fumadb({ namespace: "test", schemas: [migrateV1, migrateV2, migrateV3, migrateV4] });

type Mode = "from-schema" | "from-database";

/**
 * Drop the note lines a snapshot carries. A line that starts with `--` is a
 * `fumadb-effect deviation:` comment, not part of the script, so it is removed
 * before the comparison instead of being taught to `normalizeMigrationSql`.
 * No generated statement ever starts a line with a SQL line comment; the step
 * separator is `/* --- *\/`.
 */
const stripNotes = (sql: string): string =>
  sql
    .split("\n")
    .filter((line) => !line.startsWith("--"))
    .join("\n");

/** The script upstream fumadb produced through Kysely. */
const upstreamSnapshot = (provider: Provider, mode: Mode): string =>
  stripNotes(
    fs.readFileSync(
      path.join(
        import.meta.dirname,
        "snapshots",
        "upstream",
        "migration",
        `kysely.${provider}-${mode}.sql`,
      ),
      "utf8",
    ),
  );

/** The script this package produces where it deliberately differs from upstream. */
const localSnapshot = (provider: Provider, mode: Mode): string =>
  stripNotes(
    fs.readFileSync(
      path.join(import.meta.dirname, "snapshots", "local", "migration", `${provider}-${mode}.sql`),
      "utf8",
    ),
  );

/** Rows upstream inserted between migration steps, so later steps convert real data. */
const seedAfterStep = (step: number): Effect.Effect<void, unknown, SqlClient.SqlClient> =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    if (step === 0) {
      yield* sql`insert into ${sql("prefix_0_accounts")} ${sql.insert({ secret_id: "one" })}`;
    } else if (step === 2) {
      yield* sql`insert into ${sql("prefix_2_users")} ${sql.insert({
        id: "one",
        name: "haha",
        email: "test",
        image: "2",
      })}`;
    }
  });

/** Replay the four fixture versions and collect the script of every step. */
const replay = (
  provider: Provider,
  mode: Mode,
): Effect.Effect<string, unknown, SqlClient.SqlClient> =>
  Effect.gen(function* () {
    const scripts: Array<string> = [];
    for (let step = 0; step < 4; step++) {
      const client = TestDB.names.prefix(`prefix_${step}_`).client(sqlAdapter({ provider }));
      const migrator = yield* client.createMigrator;

      const result = yield* migrator.up({ unsafe: true, mode });
      expect(Option.isSome(yield* migrator.next)).toBe(true);

      scripts.push(Option.getOrThrow(result.sql));
      yield* result.execute;
      yield* seedAfterStep(step);
    }
    return scripts.join("\n/* --- */\n");
  });

/**
 * Providers whose `from-database` script deliberately differs from the upstream
 * oracle. Both differences are corrections in introspection
 * (`src/sql/introspect.ts`); the local snapshot's header lists them one by one.
 */
const localFromDatabase: ReadonlyArray<Provider> = ["sqlite", "mssql"];

for (const provider of providers) {
  test(`generate migration: ${provider} using from-schema`, async () => {
    const actual = await Effect.runPromise(withProvider(provider, replay(provider, "from-schema")));
    expect(normalizeMigrationSql(actual)).toBe(
      normalizeMigrationSql(upstreamSnapshot(provider, "from-schema")),
    );
  });

  test(`generate migration: ${provider} using from-database`, async () => {
    const actual = await Effect.runPromise(
      withProvider(provider, replay(provider, "from-database")),
    );
    const expected = localFromDatabase.includes(provider)
      ? localSnapshot(provider, "from-database")
      : upstreamSnapshot(provider, "from-database");
    expect(normalizeMigrationSql(actual)).toBe(normalizeMigrationSql(expected));
  });

  test(`${provider}: migrateToLatest from an empty database`, async () => {
    const program = Effect.gen(function* () {
      const client = TestDB.client(sqlAdapter({ provider }));
      const migrator = yield* client.createMigrator;

      expect(yield* migrator.version).toStrictEqual(Option.none());

      const result = yield* migrator.migrateToLatest({ unsafe: true });
      yield* result.execute;

      expect(yield* migrator.version).toStrictEqual(Option.some("4.0.0"));
      expect(Option.isSome(yield* migrator.nameVariants)).toBe(true);
      expect(Option.isNone(yield* migrator.next)).toBe(true);
    });
    await Effect.runPromise(withProvider(provider, program));
  });
}

// A minimal library, so `down` exercises the migrator rather than the quirks of
// converting the fixture schemas back and forth.
const stepV1 = schema({
  version: "1.0.0",
  tables: {
    users: table("users", {
      id: idColumn("id", Schema.String.check(Schema.isMaxLength(255))),
      name: column("name", Schema.NullOr(Schema.String.check(Schema.isMaxLength(255)))),
    }),
  },
});

const stepV2 = schema({
  version: "2.0.0",
  tables: {
    users: table("users", {
      id: idColumn("id", Schema.String.check(Schema.isMaxLength(255))),
      name: column("name", Schema.NullOr(Schema.String.check(Schema.isMaxLength(255)))),
      email: column("email", Schema.NullOr(Schema.String.check(Schema.isMaxLength(255)))),
    }),
  },
});

const StepDB = fumadb({ namespace: "step", schemas: [stepV1, stepV2] });

for (const provider of providers) {
  test(`${provider}: down restores the previous version`, async () => {
    const program = Effect.gen(function* () {
      const client = StepDB.client(sqlAdapter({ provider }));
      const migrator = yield* client.createMigrator;

      yield* Effect.flatMap(migrator.up({ unsafe: true }), (result) => result.execute);
      expect(yield* migrator.version).toStrictEqual(Option.some("1.0.0"));

      yield* Effect.flatMap(migrator.up({ unsafe: true }), (result) => result.execute);
      expect(yield* migrator.version).toStrictEqual(Option.some("2.0.0"));

      yield* Effect.flatMap(migrator.down({ unsafe: true }), (result) => result.execute);
      expect(yield* migrator.version).toStrictEqual(Option.some("1.0.0"));
      expect(Option.isNone(yield* migrator.previous)).toBe(true);

      // The column added by 2.0.0 is gone again.
      const sql = yield* SqlClient.SqlClient;
      const failure = yield* Effect.result(
        sql.unsafe<Record<string, unknown>>(`select email from users`).unprepared,
      );
      expect(Result.isFailure(failure)).toBe(true);
    });
    await Effect.runPromise(withProvider(provider, program));
  });
}

/** The column names the database reports for an unprefixed table. */
const tableColumns = (
  provider: Provider,
  table: string,
): Effect.Effect<ReadonlyArray<string>, unknown, SqlClient.SqlClient> =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    // `information_schema` spans every database on a shared server, so the
    // schema has to be pinned or a concurrent worker's `accounts` leaks in.
    const schemaName =
      provider === "mysql" ? databaseName : provider === "mssql" ? "dbo" : "public";
    const rows = yield* sql.unsafe<{ readonly name: string }>(
      provider === "sqlite"
        ? `select name from pragma_table_info('${table}')`
        : `select column_name as name from information_schema.columns ` +
            `where table_name = '${table}' and table_schema = '${schemaName}'`,
    ).unprepared;
    return rows.map((row) => row.name);
  });

/**
 * The fixture library, rolled back from 2.0.0 to 1.0.0. 2.0.0 creates
 * `accounts.email` with `defaultTo("test")`, so the downgrade has to drop a
 * column that carries a default. SQL Server refuses that while the (implicitly
 * named) default constraint still references the column, so the mssql
 * `drop-column` rendering drops the constraint first.
 */
for (const provider of providers) {
  test(`${provider}: down drops a column that has a default`, async () => {
    const program = Effect.gen(function* () {
      const client = TestDB.client(sqlAdapter({ provider }));
      const migrator = yield* client.createMigrator;

      yield* Effect.flatMap(
        migrator.migrateTo("1.0.0", { unsafe: true }),
        (result) => result.execute,
      );
      expect(yield* migrator.version).toStrictEqual(Option.some("1.0.0"));

      yield* Effect.flatMap(
        migrator.migrateTo("2.0.0", { unsafe: true }),
        (result) => result.execute,
      );
      expect(yield* migrator.version).toStrictEqual(Option.some("2.0.0"));
      expect(yield* tableColumns(provider, "accounts")).toContain("email");

      yield* Effect.flatMap(migrator.down({ unsafe: true }), (result) => result.execute);

      expect(yield* migrator.version).toStrictEqual(Option.some("1.0.0"));
      expect(yield* tableColumns(provider, "accounts")).not.toContain("email");
    });
    await Effect.runPromise(withProvider(provider, program));
  });
}

/**
 * 4.0.0 removes `users.email`, which is required and has no default. Without
 * `unsafe` the column must keep its data and stop blocking inserts, so it is
 * altered to accept NULL. SQLite cannot alter nullability: its update-column
 * path recreates the table from the target schema, which drops the column.
 */
for (const provider of providers) {
  test(`${provider}: a removed required column is made nullable without \`unsafe\``, async () => {
    const program = Effect.gen(function* () {
      const client = TestDB.client(sqlAdapter({ provider }));
      const migrator = yield* client.createMigrator;
      const sql = yield* SqlClient.SqlClient;

      yield* Effect.flatMap(
        migrator.migrateTo("3.0.0", { unsafe: true }),
        (result) => result.execute,
      );
      yield* sql`insert into ${sql("users")} ${sql.insert({ id: "one", name: "a", email: "kept" })}`;

      const result = yield* migrator.migrateTo("4.0.0");
      yield* result.execute;
      expect(yield* migrator.version).toStrictEqual(Option.some("4.0.0"));

      // An insert that omits the column succeeds.
      yield* sql`insert into ${sql("users")} ${sql.insert({ id: "two", name: "b" })}`;

      if (provider === "sqlite") {
        expect(yield* tableColumns(provider, "users")).not.toContain("email");
        return;
      }
      expect(Option.getOrThrow(result.sql)).not.toMatch(/drop column/i);
      const rows = yield* sql.unsafe<{ readonly id: string; readonly email: string | null }>(
        `select ${quoteIdentifier("id", provider)} as id, ${quoteIdentifier("email", provider)} as email from ${quoteIdentifier("users", provider)} order by id`,
      ).unprepared;
      expect(rows.map((row) => [row.id, row.email])).toEqual([
        ["one", "kept"],
        ["two", null],
      ]);
    });
    await Effect.runPromise(withProvider(provider, program));
  });
}

const markerStatement: MigrationOperation = {
  type: "custom",
  sql: "create table custom_marker (id varchar(255) not null primary key)",
};

const customV1 = schema({
  version: "1.0.0",
  tables: {
    items: table("items", { id: idColumn("id", Schema.String.check(Schema.isMaxLength(255))) }),
  },
});

const customV2 = schema({
  version: "2.0.0",
  tables: {
    items: table("items", {
      id: idColumn("id", Schema.String.check(Schema.isMaxLength(255))),
      label: column("label", Schema.NullOr(Schema.String.check(Schema.isMaxLength(255)))),
    }),
  },
  up: ({ auto }) => Effect.map(auto, (operations) => [...operations, markerStatement]),
});

const CustomDB = fumadb({ namespace: "custom", schemas: [customV1, customV2] });

for (const provider of providers) {
  test(`${provider}: a custom up receives working auto operations`, async () => {
    const program = Effect.gen(function* () {
      const client = CustomDB.client(sqlAdapter({ provider }));
      const migrator = yield* client.createMigrator;

      yield* Effect.flatMap(migrator.up({ unsafe: true }), (result) => result.execute);

      const result = yield* migrator.up({ unsafe: true });
      // `auto` produced the real diff, and the custom operation was kept.
      expect(Option.getOrThrow(result.sql)).toContain("label");
      expect(result.operations).toContainEqual(markerStatement);
      yield* result.execute;

      expect(yield* migrator.version).toStrictEqual(Option.some("2.0.0"));
      const sql = yield* SqlClient.SqlClient;
      const rows = yield* sql.unsafe<Record<string, unknown>>("select id from custom_marker")
        .unprepared;
      expect(rows.length).toBe(0);
    });
    await Effect.runPromise(withProvider(provider, program));
  });
}

const brokenV1 = schema({
  version: "1.0.0",
  tables: {
    items: table("items", { id: idColumn("id", Schema.String.check(Schema.isMaxLength(255))) }),
  },
});

const brokenV2 = schema({
  version: "2.0.0",
  tables: {
    items: table("items", {
      id: idColumn("id", Schema.String.check(Schema.isMaxLength(255))),
      label: column("label", Schema.NullOr(Schema.String.check(Schema.isMaxLength(255)))),
    }),
  },
  up: ({ auto }) =>
    Effect.map(auto, (operations) => [
      ...operations,
      { type: "custom", sql: "this is not valid sql" } satisfies MigrationOperation,
    ]),
});

const BrokenDB = fumadb({ namespace: "broken", schemas: [brokenV1, brokenV2] });

/**
 * Providers that roll DDL back when the transaction aborts. MySQL commits
 * every DDL statement implicitly, and CockroachDB keeps the schema change of
 * an aborted transaction as well (verified against both containers), so the
 * added column survives there.
 */
const rollsBackDdl: ReadonlyArray<Provider> = ["postgresql", "sqlite", "mssql"];

for (const provider of providers) {
  test(`${provider}: a failing statement aborts the whole migration`, async () => {
    const program = Effect.gen(function* () {
      const client = BrokenDB.client(sqlAdapter({ provider }));
      const migrator = yield* client.createMigrator;

      yield* Effect.flatMap(migrator.up({ unsafe: true }), (result) => result.execute);
      expect(yield* migrator.version).toStrictEqual(Option.some("1.0.0"));

      const result = yield* migrator.up({ unsafe: true });
      const outcome = yield* Effect.result(result.execute);

      expect(Result.isFailure(outcome)).toBe(true);
      if (Result.isFailure(outcome)) {
        expect(outcome.failure).toBeInstanceOf(MigrationError);
        if (outcome.failure instanceof MigrationError) {
          expect(outcome.failure.reason).toBe("Execution");
          expect(outcome.failure.statement).toBe("this is not valid sql");
        }
      }

      // The settings were the last statements, so the version never moved.
      expect(yield* migrator.version).toStrictEqual(Option.some("1.0.0"));

      if (rollsBackDdl.includes(provider)) {
        // The column added before the broken statement is gone again.
        const sql = yield* SqlClient.SqlClient;
        const select = yield* Effect.result(
          sql.unsafe<Record<string, unknown>>("select label from items").unprepared,
        );
        expect(Result.isFailure(select)).toBe(true);
      }
    });
    await Effect.runPromise(withProvider(provider, program));
  });
}

// ---------------------------------------------------------------------------
// Column definitions survive the migration that changes them
// ---------------------------------------------------------------------------

const nullabilityV1 = schema({
  version: "1.0.0",
  tables: {
    widgets: table("widgets", {
      id: idColumn("id", Schema.String.check(Schema.isMaxLength(255))),
      label: column("label", Schema.String.check(Schema.isMaxLength(100))),
      note: column("note", Schema.NullOr(Schema.String.check(Schema.isMaxLength(100)))),
    }),
  },
});

/** The same two columns, with a different type and the same nullability. */
const nullabilityV2 = schema({
  version: "2.0.0",
  tables: {
    widgets: table("widgets", {
      id: idColumn("id", Schema.String.check(Schema.isMaxLength(255))),
      label: column("label", Schema.String),
      note: column("note", Schema.NullOr(Schema.String)),
    }),
  },
});

const NullabilityDB = fumadb({ namespace: "nullability", schemas: [nullabilityV1, nullabilityV2] });

/** Which columns of `table` the live database reports as nullable. */
const nullabilityOf = (
  provider: Provider,
  table: string,
): Effect.Effect<Record<string, boolean>, unknown, SqlClient.SqlClient> =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    if (provider === "sqlite") {
      const rows = yield* sql<{ name: string; not_null: unknown }>`
        SELECT name, "notnull" AS not_null FROM pragma_table_info(${table})`;
      return Object.fromEntries(rows.map((row) => [row.name, Number(row.not_null) === 0]));
    }
    const rows = yield* sql<{ name: string; nullable: string }>`
      SELECT column_name AS name, is_nullable AS nullable
      FROM information_schema.columns WHERE table_name = ${table}`;
    return Object.fromEntries(
      rows.map((row) => [row.name, String(row.nullable).toUpperCase() === "YES"]),
    );
  });

for (const provider of providers) {
  // T-SQL makes a column nullable whenever `ALTER COLUMN c <type>` leaves the
  // nullability out, so a type change used to silently drop `NOT NULL` on MSSQL.
  test(`${provider}: a type change keeps the column's nullability`, async () => {
    const program = Effect.gen(function* () {
      const client = NullabilityDB.client(sqlAdapter({ provider }));
      const migrator = yield* client.createMigrator;

      yield* Effect.flatMap(migrator.up({ unsafe: true }), (result) => result.execute);
      expect(yield* nullabilityOf(provider, "widgets")).toMatchObject({ label: false, note: true });

      yield* Effect.flatMap(migrator.up({ unsafe: true }), (result) => result.execute);
      expect(yield* migrator.version).toStrictEqual(Option.some("2.0.0"));

      // The type changed on both columns; neither nullability did.
      expect(yield* nullabilityOf(provider, "widgets")).toMatchObject({ label: false, note: true });
    });
    await Effect.runPromise(withProvider(provider, program));
  });
}

const decimalV1 = schema({
  version: "1.0.0",
  tables: {
    readings: table("readings", {
      id: idColumn("id", Schema.String.check(Schema.isMaxLength(255))),
      value: column("value", Schema.Number),
    }),
  },
});

const DecimalDB = fumadb({ namespace: "decimal", schemas: [decimalV1] });

for (const provider of providers) {
  // A bare `decimal` is DECIMAL(10, 0) on MySQL and DECIMAL(18, 0) on SQL
  // Server, which stored 1.5 as 2; `schemaToDbType` writes `decimal(38,10)` there.
  test(`${provider}: a decimal column keeps a fractional value`, async () => {
    const program = Effect.gen(function* () {
      const client = DecimalDB.client(sqlAdapter({ provider }));
      const migrator = yield* client.createMigrator;
      yield* Effect.flatMap(migrator.migrateToLatest({ unsafe: true }), (result) => result.execute);

      const sql = yield* SqlClient.SqlClient;
      const name = (identifier: string): string => quoteIdentifier(identifier, provider);
      // A literal, not a parameter, so the assertion is about the column type
      // rather than about how the driver types a bound number.
      yield* sql.unsafe(
        `insert into ${name("readings")} (${name("id")}, ${name("value")}) values ('one', 1.5)`,
      ).unprepared;
      const rows = yield* sql.unsafe<{ readonly value: unknown }>(
        `select ${name("value")} from ${name("readings")}`,
      ).unprepared;

      expect(rows).toHaveLength(1);
      expect(Number(rows[0]?.value)).toBe(1.5);
    });
    await Effect.runPromise(withProvider(provider, program));
  });
}

// An id column cannot be altered on any provider, so the plan the diff produces
// for a changed id type has no SQL form.
const idTypeV1 = schema({
  version: "1.0.0",
  tables: {
    things: table("things", { id: idColumn("id", Schema.String.check(Schema.isMaxLength(255))) }),
  },
});

const idTypeV2 = schema({
  version: "2.0.0",
  tables: { things: table("things", { id: idColumn("id", Schema.String.check(Schema.isUUID())) }) },
});

const IdTypeDB = fumadb({ namespace: "idtype", schemas: [idTypeV1, idTypeV2] });

for (const provider of providers) {
  // SQLite rewrites every unsupported column change into a table recreate, so
  // it is the one provider that can still render this plan.
  if (provider === "sqlite") continue;

  test(`${provider}: a plan with no SQL form fails instead of returning a script`, async () => {
    const program = Effect.gen(function* () {
      const client = IdTypeDB.client(sqlAdapter({ provider }));
      const migrator = yield* client.createMigrator;
      yield* Effect.flatMap(migrator.up({ unsafe: true }), (result) => result.execute);

      const outcome = yield* Effect.result(migrator.up({ unsafe: true }));
      expect(Result.isFailure(outcome)).toBe(true);
      if (Result.isFailure(outcome)) {
        expect(outcome.failure).toBeInstanceOf(MigrationError);
        if (outcome.failure instanceof MigrationError) {
          expect(outcome.failure.reason).toBe("Unsupported");
          expect(outcome.failure.message).toContain("ID columns must not be updated");
        }
      }
      // The version did not move, and nothing was executed.
      expect(yield* migrator.version).toStrictEqual(Option.some("1.0.0"));
    });
    await Effect.runPromise(withProvider(provider, program));
  });
}
