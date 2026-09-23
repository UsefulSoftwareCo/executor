/**
 * Database introspection (`mode: "from-database"`) against real databases.
 *
 * Tables are created with hand-written DDL — not with the FumaDB migrator — so
 * the catalogue queries are exercised against SQL the package did not produce.
 */
import { it } from "@effect/vitest";
import { Effect, Result, Schema } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { expect } from "vitest";
import type { Provider } from "../src/contracts/provider.ts";
import { defaultRelationMode } from "../src/contracts/provider.ts";
import type { StorageType } from "../src/contracts/schema/column.ts";

import {
  column as makeColumn,
  idColumn,
  schema as makeSchema,
  table as makeTable,
} from "../src/schema.ts";
import type { AnySchema } from "../src/contracts/schema/schema.ts";
import type { AnyTable } from "../src/contracts/schema/table.ts";
import { renderStatements } from "../src/implementation/sql/ddl.ts";
import {
  generateMigrationFromDatabase,
  introspectSchema,
} from "../src/implementation/sql/introspect.ts";
import type { MigrationOperation } from "../src/contracts/migration-operation.ts";
import { providers, withProvider } from "./support/databases.ts";
import { migrateV2 } from "./support/schemas.ts";

// ---------------------------------------------------------------------------
// Hand-written fixtures
// ---------------------------------------------------------------------------

/**
 * One table per interesting shape: every FumaDB column type, nullable and
 * non-nullable columns, literal defaults, a column-level unique, a named
 * composite unique, a self-referencing foreign key, and a foreign key with
 * `CASCADE` actions.
 */
const coverageDdl: Record<Provider, ReadonlyArray<string>> = {
  postgresql: [
    `CREATE TABLE "private_test_settings" ("key" varchar(255) NOT NULL PRIMARY KEY, "value" text NOT NULL)`,
    `CREATE TABLE "intro_users" (
      "id" varchar(255) NOT NULL PRIMARY KEY,
      "email" varchar(255) NOT NULL,
      "nickname" varchar(80) UNIQUE,
      "tag" varchar(50) DEFAULT 'none',
      "age" integer DEFAULT 21,
      "active" boolean NOT NULL DEFAULT true,
      "parent_id" varchar(255),
      CONSTRAINT "intro_users_tag_age_uk" UNIQUE ("tag", "age"),
      CONSTRAINT "intro_users_parent_fk" FOREIGN KEY ("parent_id") REFERENCES "intro_users" ("id")
    )`,
    `CREATE TABLE "intro_items" (
      "id" varchar(255) NOT NULL PRIMARY KEY,
      "owner_id" varchar(255) NOT NULL,
      "c_string" text,
      "c_bigint" bigint,
      "c_integer" integer,
      "c_decimal" decimal,
      "c_bool" boolean,
      "c_json" json,
      "c_binary" bytea,
      "c_date" date,
      "c_timestamp" timestamp,
      "c_uuid" uuid,
      CONSTRAINT "intro_items_owner_fk" FOREIGN KEY ("owner_id") REFERENCES "intro_users" ("id")
        ON DELETE CASCADE ON UPDATE CASCADE
    )`,
  ],
  cockroachdb: [
    `CREATE TABLE "private_test_settings" ("key" varchar(255) NOT NULL PRIMARY KEY, "value" text NOT NULL)`,
    `CREATE TABLE "intro_users" (
      "id" varchar(255) NOT NULL PRIMARY KEY,
      "email" varchar(255) NOT NULL,
      "nickname" varchar(80) UNIQUE,
      "tag" varchar(50) DEFAULT 'none',
      "age" integer DEFAULT 21,
      "active" boolean NOT NULL DEFAULT true,
      "parent_id" varchar(255),
      CONSTRAINT "intro_users_tag_age_uk" UNIQUE ("tag", "age"),
      CONSTRAINT "intro_users_parent_fk" FOREIGN KEY ("parent_id") REFERENCES "intro_users" ("id")
    )`,
    `CREATE TABLE "intro_items" (
      "id" varchar(255) NOT NULL PRIMARY KEY,
      "owner_id" varchar(255) NOT NULL,
      "c_string" text,
      "c_bigint" bigint,
      "c_integer" integer,
      "c_decimal" decimal,
      "c_bool" boolean,
      "c_json" json,
      "c_binary" bytea,
      "c_date" date,
      "c_timestamp" timestamp,
      "c_uuid" uuid,
      CONSTRAINT "intro_items_owner_fk" FOREIGN KEY ("owner_id") REFERENCES "intro_users" ("id")
        ON DELETE CASCADE ON UPDATE CASCADE
    )`,
  ],
  mysql: [
    "CREATE TABLE `private_test_settings` (`key` varchar(255) NOT NULL PRIMARY KEY, `value` text NOT NULL)",
    "CREATE TABLE `intro_users` (" +
      "`id` varchar(255) NOT NULL PRIMARY KEY," +
      "`email` varchar(255) NOT NULL," +
      "`nickname` varchar(80) UNIQUE," +
      "`tag` varchar(50) DEFAULT 'none'," +
      "`age` integer DEFAULT 21," +
      "`active` boolean NOT NULL DEFAULT true," +
      "`parent_id` varchar(255)," +
      "CONSTRAINT `intro_users_tag_age_uk` UNIQUE (`tag`, `age`)," +
      "CONSTRAINT `intro_users_parent_fk` FOREIGN KEY (`parent_id`) REFERENCES `intro_users` (`id`))",
    "CREATE TABLE `intro_items` (" +
      "`id` varchar(255) NOT NULL PRIMARY KEY," +
      "`owner_id` varchar(255) NOT NULL," +
      "`c_string` text," +
      "`c_bigint` bigint," +
      "`c_integer` integer," +
      "`c_decimal` decimal," +
      "`c_bool` boolean," +
      "`c_json` json," +
      "`c_binary` longblob," +
      "`c_date` date," +
      "`c_timestamp` timestamp NULL," +
      "`c_uuid` char(36)," +
      "CONSTRAINT `intro_items_owner_fk` FOREIGN KEY (`owner_id`) REFERENCES `intro_users` (`id`)" +
      " ON DELETE CASCADE ON UPDATE CASCADE)",
  ],
  mssql: [
    `CREATE TABLE [private_test_settings] ([key] varchar(255) NOT NULL PRIMARY KEY, [value] varchar(max) NOT NULL)`,
    `CREATE TABLE [intro_users] (
      [id] varchar(255) NOT NULL PRIMARY KEY,
      [email] varchar(255) NOT NULL,
      [nickname] varchar(80) UNIQUE,
      [tag] varchar(50) DEFAULT 'none',
      [age] int DEFAULT 21,
      [active] bit NOT NULL DEFAULT 1,
      [parent_id] varchar(255),
      CONSTRAINT [intro_users_tag_age_uk] UNIQUE ([tag], [age]),
      CONSTRAINT [intro_users_parent_fk] FOREIGN KEY ([parent_id]) REFERENCES [intro_users] ([id])
    )`,
    `CREATE TABLE [intro_items] (
      [id] varchar(255) NOT NULL PRIMARY KEY,
      [owner_id] varchar(255) NOT NULL,
      [c_string] varchar(max),
      [c_bigint] bigint,
      [c_integer] int,
      [c_decimal] decimal,
      [c_bool] bit,
      [c_json] varchar(max),
      [c_binary] varbinary(max),
      [c_date] date,
      [c_timestamp] datetime,
      [c_uuid] uniqueidentifier,
      CONSTRAINT [intro_items_owner_fk] FOREIGN KEY ([owner_id]) REFERENCES [intro_users] ([id])
        ON DELETE CASCADE ON UPDATE CASCADE
    )`,
  ],
  sqlite: [
    `CREATE TABLE "private_test_settings" ("key" varchar(255) NOT NULL PRIMARY KEY, "value" text NOT NULL)`,
    `CREATE TABLE "intro_users" (
      "id" varchar(255) NOT NULL PRIMARY KEY,
      "email" varchar(255) NOT NULL,
      "nickname" varchar(80) UNIQUE,
      "tag" varchar(50) DEFAULT 'none',
      "age" integer DEFAULT 21,
      "active" integer NOT NULL DEFAULT 1,
      "parent_id" varchar(255),
      CONSTRAINT "intro_users_parent_fk" FOREIGN KEY ("parent_id") REFERENCES "intro_users" ("id")
    )`,
    // SQLite forgets the name of a table-level UNIQUE constraint, so FumaDB's
    // own DDL uses named unique indexes; the fixture does the same.
    `CREATE UNIQUE INDEX "intro_users_tag_age_uk" ON "intro_users" ("tag", "age")`,
    `CREATE TABLE "intro_items" (
      "id" varchar(255) NOT NULL PRIMARY KEY,
      "owner_id" varchar(255) NOT NULL,
      "c_string" text,
      "c_bigint" blob,
      "c_integer" integer,
      "c_decimal" real,
      "c_bool" integer,
      "c_json" text,
      "c_binary" blob,
      "c_date" integer,
      "c_timestamp" integer,
      "c_uuid" text,
      CONSTRAINT "intro_items_owner_fk" FOREIGN KEY ("owner_id") REFERENCES "intro_users" ("id")
        ON DELETE CASCADE ON UPDATE CASCADE
    )`,
  ],
};

/**
 * The FumaDB type each fixture column is read back as, with no target schema
 * to disambiguate. SQLite has only four storage classes, so several of its
 * columns can only be resolved against a target schema (see the `migrateV2`
 * tests below); the values here are the documented first candidates.
 */
const expectedTypes: Record<Provider, Record<string, StorageType>> = {
  postgresql: {
    id: "varchar(255)",
    email: "varchar(255)",
    nickname: "varchar(80)",
    tag: "varchar(50)",
    age: "integer",
    active: "bool",
    parent_id: "varchar(255)",
    owner_id: "varchar(255)",
    c_string: "string",
    c_bigint: "bigint",
    c_integer: "integer",
    c_decimal: "decimal",
    c_bool: "bool",
    c_json: "json",
    c_binary: "binary",
    c_date: "date",
    c_timestamp: "timestamp",
    c_uuid: "uuid",
  },
  cockroachdb: {
    id: "varchar(255)",
    email: "varchar(255)",
    nickname: "varchar(80)",
    tag: "varchar(50)",
    // CockroachDB's INTEGER is a 64-bit INT8.
    age: "bigint",
    active: "bool",
    parent_id: "varchar(255)",
    owner_id: "varchar(255)",
    c_string: "string",
    c_bigint: "bigint",
    c_integer: "bigint",
    c_decimal: "decimal",
    c_bool: "bool",
    c_json: "json",
    c_binary: "binary",
    c_date: "date",
    c_timestamp: "timestamp",
    c_uuid: "uuid",
  },
  mysql: {
    id: "varchar(255)",
    email: "varchar(255)",
    nickname: "varchar(80)",
    tag: "varchar(50)",
    age: "integer",
    active: "bool",
    parent_id: "varchar(255)",
    owner_id: "varchar(255)",
    c_string: "string",
    c_bigint: "bigint",
    c_integer: "integer",
    c_decimal: "decimal",
    c_bool: "bool",
    c_json: "json",
    c_binary: "binary",
    c_date: "date",
    c_timestamp: "timestamp",
    c_uuid: "uuid",
  },
  mssql: {
    id: "varchar(255)",
    email: "varchar(255)",
    nickname: "varchar(80)",
    tag: "varchar(50)",
    age: "integer",
    active: "bool",
    parent_id: "varchar(255)",
    owner_id: "varchar(255)",
    // `varchar(max)` carries both `string` and `json`; `string` wins by default.
    c_string: "string",
    c_bigint: "bigint",
    c_integer: "integer",
    c_decimal: "decimal",
    c_bool: "bool",
    c_json: "string",
    c_binary: "binary",
    c_date: "date",
    c_timestamp: "timestamp",
    c_uuid: "uuid",
  },
  sqlite: {
    id: "varchar(255)",
    email: "varchar(255)",
    nickname: "varchar(80)",
    tag: "varchar(50)",
    age: "integer",
    active: "integer",
    parent_id: "varchar(255)",
    owner_id: "varchar(255)",
    c_string: "string",
    c_bigint: "bigint",
    c_integer: "integer",
    c_decimal: "decimal",
    c_bool: "integer",
    c_json: "string",
    c_binary: "bigint",
    c_date: "integer",
    c_timestamp: "integer",
    c_uuid: "string",
  },
};

/** The `age` default, once it is read back as the type above. */
const expectedAgeDefault: Record<Provider, unknown> = {
  postgresql: 21,
  cockroachdb: 21n,
  mysql: 21,
  mssql: 21,
  sqlite: 21,
};

/** The `active` default: SQLite reads `DEFAULT 1` back as an `integer`. */
const expectedActiveDefault: Record<Provider, unknown> = {
  postgresql: true,
  cockroachdb: true,
  mysql: true,
  mssql: true,
  sqlite: 1,
};

/** `migrateV2`, written by hand exactly as each provider's DDL generator would. */
const migrateV2Ddl: Record<Provider, ReadonlyArray<string>> = {
  postgresql: [
    `CREATE TABLE "accounts" (
      "secret_id" varchar(255) NOT NULL PRIMARY KEY,
      "email" varchar(255) DEFAULT 'test' NOT NULL,
      CONSTRAINT "unique_c_accounts_email" UNIQUE ("email")
    )`,
    `CREATE TABLE "users" (
      "id" varchar(255) NOT NULL PRIMARY KEY,
      "name" varchar(255) NOT NULL,
      "email" varchar(255) NOT NULL,
      "image" text DEFAULT 'another-avatar',
      "string" text,
      "bigint" bigint,
      "integer" integer,
      "decimal" decimal,
      "bool" boolean,
      "json" json,
      "binary" bytea,
      "date" date,
      "timestamp" timestamp,
      "fatherId" varchar(255),
      CONSTRAINT "unique_c_users_email" UNIQUE ("email"),
      CONSTRAINT "unique_c_users_fatherId" UNIQUE ("fatherId"),
      CONSTRAINT "users_accounts_account_fk" FOREIGN KEY ("email") REFERENCES "accounts" ("secret_id")
        ON DELETE CASCADE ON UPDATE RESTRICT,
      CONSTRAINT "users_users_father_fk" FOREIGN KEY ("fatherId") REFERENCES "users" ("id")
        ON DELETE RESTRICT ON UPDATE RESTRICT
    )`,
  ],
  cockroachdb: [
    `CREATE TABLE "accounts" (
      "secret_id" varchar(255) NOT NULL PRIMARY KEY,
      "email" varchar(255) DEFAULT 'test' NOT NULL,
      CONSTRAINT "unique_c_accounts_email" UNIQUE ("email")
    )`,
    `CREATE TABLE "users" (
      "id" varchar(255) NOT NULL PRIMARY KEY,
      "name" varchar(255) NOT NULL,
      "email" varchar(255) NOT NULL,
      "image" text DEFAULT 'another-avatar',
      "string" text,
      "bigint" bigint,
      "integer" integer,
      "decimal" decimal,
      "bool" boolean,
      "json" json,
      "binary" bytea,
      "date" date,
      "timestamp" timestamp,
      "fatherId" varchar(255),
      CONSTRAINT "unique_c_users_email" UNIQUE ("email"),
      CONSTRAINT "unique_c_users_fatherId" UNIQUE ("fatherId"),
      CONSTRAINT "users_accounts_account_fk" FOREIGN KEY ("email") REFERENCES "accounts" ("secret_id")
        ON DELETE CASCADE ON UPDATE RESTRICT,
      CONSTRAINT "users_users_father_fk" FOREIGN KEY ("fatherId") REFERENCES "users" ("id")
        ON DELETE RESTRICT ON UPDATE RESTRICT
    )`,
  ],
  mysql: [
    "CREATE TABLE `accounts` (" +
      "`secret_id` varchar(255) NOT NULL PRIMARY KEY," +
      "`email` varchar(255) NOT NULL DEFAULT 'test'," +
      "CONSTRAINT `unique_c_accounts_email` UNIQUE (`email`))",
    "CREATE TABLE `users` (" +
      "`id` varchar(255) NOT NULL PRIMARY KEY," +
      "`name` varchar(255) NOT NULL," +
      "`email` varchar(255) NOT NULL," +
      "`image` text," +
      "`string` text," +
      "`bigint` bigint," +
      "`integer` integer," +
      "`decimal` decimal," +
      "`bool` boolean," +
      "`json` json," +
      "`binary` longblob," +
      "`date` date," +
      "`timestamp` timestamp NULL," +
      "`fatherId` varchar(255)," +
      "CONSTRAINT `unique_c_users_email` UNIQUE (`email`)," +
      "CONSTRAINT `unique_c_users_fatherId` UNIQUE (`fatherId`)," +
      "CONSTRAINT `users_accounts_account_fk` FOREIGN KEY (`email`) REFERENCES `accounts` (`secret_id`)" +
      " ON DELETE CASCADE ON UPDATE RESTRICT," +
      "CONSTRAINT `users_users_father_fk` FOREIGN KEY (`fatherId`) REFERENCES `users` (`id`)" +
      " ON DELETE RESTRICT ON UPDATE RESTRICT)",
  ],
  mssql: [
    // MSSQL uses FumaDB's own relation engine, so the DDL carries no foreign keys.
    `CREATE TABLE [accounts] (
      [secret_id] varchar(255) NOT NULL PRIMARY KEY,
      [email] varchar(255) NOT NULL DEFAULT 'test'
    )`,
    `CREATE UNIQUE INDEX [unique_c_accounts_email] ON [accounts] ([email]) WHERE [email] IS NOT NULL`,
    `CREATE TABLE [users] (
      [id] varchar(255) NOT NULL PRIMARY KEY,
      [name] varchar(255) NOT NULL,
      [email] varchar(255) NOT NULL,
      [image] varchar(max) DEFAULT 'another-avatar',
      [string] varchar(max),
      [bigint] bigint,
      [integer] int,
      [decimal] decimal,
      [bool] bit,
      [json] varchar(max),
      [binary] varbinary(max),
      [date] date,
      [timestamp] datetime,
      [fatherId] varchar(255)
    )`,
    `CREATE UNIQUE INDEX [unique_c_users_email] ON [users] ([email]) WHERE [email] IS NOT NULL`,
    `CREATE UNIQUE INDEX [unique_c_users_fatherId] ON [users] ([fatherId]) WHERE [fatherId] IS NOT NULL`,
  ],
  sqlite: [
    `CREATE TABLE "accounts" (
      "secret_id" text NOT NULL PRIMARY KEY,
      "email" text NOT NULL DEFAULT 'test'
    )`,
    `CREATE UNIQUE INDEX "unique_c_accounts_email" ON "accounts" ("email")`,
    `CREATE TABLE "users" (
      "id" text NOT NULL PRIMARY KEY,
      "name" text NOT NULL,
      "email" text NOT NULL,
      "image" text DEFAULT 'another-avatar',
      "string" text,
      "bigint" blob,
      "integer" integer,
      "decimal" real,
      "bool" integer,
      "json" text,
      "binary" blob,
      "date" integer,
      "timestamp" integer,
      "fatherId" text,
      CONSTRAINT "users_accounts_account_fk" FOREIGN KEY ("email") REFERENCES "accounts" ("secret_id")
        ON DELETE CASCADE ON UPDATE RESTRICT,
      CONSTRAINT "users_users_father_fk" FOREIGN KEY ("fatherId") REFERENCES "users" ("id")
        ON DELETE RESTRICT ON UPDATE RESTRICT
    )`,
    `CREATE UNIQUE INDEX "unique_c_users_email" ON "users" ("email")`,
    `CREATE UNIQUE INDEX "unique_c_users_fatherId" ON "users" ("fatherId")`,
  ],
};

/** `ALTER TABLE users ADD` / `DROP COLUMN`, spelled per provider. */
const alterUsers: Record<
  Provider,
  { readonly add: string; readonly dropExtra: string; readonly dropName: string }
> = {
  postgresql: {
    add: `ALTER TABLE "users" ADD COLUMN "extra_col" varchar(50)`,
    dropExtra: `ALTER TABLE "users" DROP COLUMN "extra_col"`,
    dropName: `ALTER TABLE "users" DROP COLUMN "name"`,
  },
  cockroachdb: {
    add: `ALTER TABLE "users" ADD COLUMN "extra_col" varchar(50)`,
    dropExtra: `ALTER TABLE "users" DROP COLUMN "extra_col"`,
    dropName: `ALTER TABLE "users" DROP COLUMN "name"`,
  },
  mysql: {
    add: "ALTER TABLE `users` ADD COLUMN `extra_col` varchar(50)",
    dropExtra: "ALTER TABLE `users` DROP COLUMN `extra_col`",
    dropName: "ALTER TABLE `users` DROP COLUMN `name`",
  },
  mssql: {
    add: `ALTER TABLE [users] ADD [extra_col] varchar(50)`,
    dropExtra: `ALTER TABLE [users] DROP COLUMN [extra_col]`,
    dropName: `ALTER TABLE [users] DROP COLUMN [name]`,
  },
  sqlite: {
    add: `ALTER TABLE "users" ADD COLUMN "extra_col" varchar(50)`,
    dropExtra: `ALTER TABLE "users" DROP COLUMN "extra_col"`,
    dropName: `ALTER TABLE "users" DROP COLUMN "name"`,
  },
};

// ---------------------------------------------------------------------------
// Default-value round trip
// ---------------------------------------------------------------------------

/** The Date every date and timestamp default in `intro_defaults` carries. */
const defaultMoment = new Date("2020-01-02T00:00:00.000Z");

/** A bigint too large to survive as a `number`. */
const defaultBigInt = 90071992547409910n;

/** A string default whose quoting every provider escapes differently. */
const defaultQuoted = "it's a 'quote'";

/**
 * One column per kind of default a FumaDB column can carry, so
 * `normalizeDefault` is exercised against the real catalogue text of each
 * provider (a naive `timestamp` literal, CockroachDB's `e'...'` escape string,
 * and MSSQL's `((90071992547409910.))` numeric literal all used to read back
 * as something else).
 *
 * The literals are written the way `src/sql/ddl.ts` writes them, except where
 * a provider rejects that spelling: MySQL needs `YYYY-MM-DD HH:MM:SS` for a
 * `timestamp` and a bare `1` for a `bit`-like default.
 */
const defaultsDdl: Record<Provider, ReadonlyArray<string>> = {
  postgresql: [
    `CREATE TABLE "intro_defaults" (
      "id" varchar(255) NOT NULL PRIMARY KEY,
      "ts" timestamp DEFAULT '2020-01-02T00:00:00.000Z',
      "d" date DEFAULT '2020-01-02',
      "big" bigint DEFAULT 90071992547409910,
      "q" varchar(50) DEFAULT 'it''s a ''quote''',
      "n" integer DEFAULT 21,
      "flag" boolean DEFAULT true
    )`,
  ],
  cockroachdb: [
    `CREATE TABLE "intro_defaults" (
      "id" varchar(255) NOT NULL PRIMARY KEY,
      "ts" timestamp DEFAULT '2020-01-02T00:00:00.000Z',
      "d" date DEFAULT '2020-01-02',
      "big" bigint DEFAULT 90071992547409910,
      "q" varchar(50) DEFAULT 'it''s a ''quote''',
      "n" integer DEFAULT 21,
      "flag" boolean DEFAULT true
    )`,
  ],
  mysql: [
    "CREATE TABLE `intro_defaults` (" +
      "`id` varchar(255) NOT NULL PRIMARY KEY," +
      "`ts` timestamp NULL DEFAULT '2020-01-02 00:00:00'," +
      "`d` date DEFAULT '2020-01-02'," +
      "`big` bigint DEFAULT 90071992547409910," +
      "`q` varchar(50) DEFAULT 'it''s a ''quote'''," +
      "`n` integer DEFAULT 21," +
      "`flag` boolean DEFAULT true)",
  ],
  mssql: [
    `CREATE TABLE [intro_defaults] (
      [id] varchar(255) NOT NULL PRIMARY KEY,
      [ts] datetime DEFAULT '2020-01-02T00:00:00.000Z',
      [d] date DEFAULT '2020-01-02',
      [big] bigint DEFAULT 90071992547409910,
      [q] varchar(50) DEFAULT 'it''s a ''quote''',
      [n] int DEFAULT 21,
      [flag] bit DEFAULT 1
    )`,
  ],
  sqlite: [
    // SQLite keeps a date or timestamp as a number of milliseconds, and FumaDB
    // writes the literal as the ISO text of the Date.
    `CREATE TABLE "intro_defaults" (
      "id" varchar(255) NOT NULL PRIMARY KEY,
      "ts" integer DEFAULT '2020-01-02T00:00:00.000Z',
      "d" integer DEFAULT '2020-01-02T00:00:00.000Z',
      "big" blob DEFAULT 90071992547409910,
      "q" varchar(50) DEFAULT 'it''s a ''quote''',
      "n" integer DEFAULT 21,
      "flag" integer DEFAULT 1
    )`,
  ],
};

/** The FumaDB type of each `intro_defaults` column, in the target schema. */
const defaultsStorageTypes: Record<string, StorageType> = {
  id: "varchar(255)",
  ts: "timestamp",
  d: "date",
  big: "bigint",
  q: "varchar(50)",
  n: "integer",
  flag: "bool",
};

/** The schema `defaultsDdl` is the database form of. */
const defaultsSchema = makeSchema({
  version: "1.0.0",
  tables: {
    intro_defaults: makeTable("intro_defaults", {
      id: idColumn("id", Schema.String.check(Schema.isMaxLength(255))),
      ts: makeColumn("ts", Schema.NullOr(Schema.Date)).default(defaultMoment),
      d: makeColumn("d", Schema.NullOr(Schema.Date), { type: "date" }).default(defaultMoment),
      big: makeColumn("big", Schema.NullOr(Schema.BigInt)).default(defaultBigInt),
      q: makeColumn("q", Schema.NullOr(Schema.String.check(Schema.isMaxLength(50)))).default(
        defaultQuoted,
      ),
      n: makeColumn("n", Schema.NullOr(Schema.Int)).default(21),
      flag: makeColumn("flag", Schema.NullOr(Schema.Boolean)).default(true),
    }),
  },
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const runDdl = (
  statements: ReadonlyArray<string>,
): Effect.Effect<void, unknown, SqlClient.SqlClient> =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    for (const statement of statements) yield* sql.unsafe(statement);
  });

const getTable = (schema: AnySchema, name: string): AnyTable => {
  const table = schema.tables[name];
  if (table === undefined)
    throw new Error(`Table "${name}" is missing; found ${Object.keys(schema.tables).join(", ")}`);
  return table;
};

const columnSummary = (table: AnyTable, ormName: string) => {
  const column = table.columns[ormName];
  if (column === undefined) throw new Error(`Column "${ormName}" is missing on "${table.ormName}"`);
  return {
    sql: column.names.sql,
    type: column.type,
    isNullable: column.isNullable,
    default:
      column.defaultValue === undefined || column.defaultValue._tag === "Runtime"
        ? undefined
        : column.defaultValue.value,
  };
};

const uniqueColumnNames = (table: AnyTable): ReadonlyArray<ReadonlyArray<string>> =>
  table.getUniqueConstraints().map((con) => con.columns.map((col) => col.ormName));

const foreignKeySummary = (table: AnyTable) =>
  table.foreignKeys
    .map((key) => ({
      name: key.name,
      columns: key.columns.map((col) => col.names.sql),
      referencedTable: key.referencedTable.names.sql,
      referencedColumns: key.referencedColumns.map((col) => col.names.sql),
      onDelete: key.onDelete,
      onUpdate: key.onUpdate,
    }))
    .sort((a, b) => a.name.localeCompare(b.name));

const configOf = (provider: Provider) => ({
  provider,
  relationMode: defaultRelationMode(provider),
});

const diffAgainstMigrateV2 = (
  provider: Provider,
  dropUnusedColumns: boolean,
): Effect.Effect<ReadonlyArray<MigrationOperation>, unknown, SqlClient.SqlClient> =>
  generateMigrationFromDatabase(migrateV2, configOf(provider), {
    nameVariants: undefined,
    dropUnusedColumns,
    internalTables: ["private_test_settings"],
  });

const columnOperations = (operations: ReadonlyArray<MigrationOperation>, tableName: string) =>
  operations.flatMap((op) =>
    op.type === "update-table" && op.name === tableName ? [...op.value] : [],
  );

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

for (const provider of providers) {
  it.live(
    `introspects a hand-written database: ${provider}`,
    () =>
      Effect.gen(function* () {
        const schema = yield* withProvider(
          provider,
          Effect.gen(function* () {
            yield* runDdl(coverageDdl[provider]);
            return yield* introspectSchema({ provider, internalTables: ["private_test_settings"] });
          }),
        );

        // The settings table is excluded; nothing else is.
        expect(Object.keys(schema.tables).sort()).toEqual(["intro_items", "intro_users"]);

        const users = getTable(schema, "intro_users");
        const items = getTable(schema, "intro_items");
        const types = expectedTypes[provider];

        expect(Object.keys(users.columns)).toEqual([
          "id",
          "email",
          "nickname",
          "tag",
          "age",
          "active",
          "parent_id",
        ]);
        expect(Object.keys(items.columns)).toEqual([
          "id",
          "owner_id",
          "c_string",
          "c_bigint",
          "c_integer",
          "c_decimal",
          "c_bool",
          "c_json",
          "c_binary",
          "c_date",
          "c_timestamp",
          "c_uuid",
        ]);

        expect(columnSummary(users, "id")).toEqual({
          sql: "id",
          type: types["id"],
          isNullable: false,
          default: undefined,
        });
        expect(columnSummary(users, "email")).toEqual({
          sql: "email",
          type: types["email"],
          isNullable: false,
          default: undefined,
        });
        expect(columnSummary(users, "nickname")).toEqual({
          sql: "nickname",
          type: types["nickname"],
          isNullable: true,
          default: undefined,
        });
        expect(columnSummary(users, "tag")).toEqual({
          sql: "tag",
          type: types["tag"],
          isNullable: true,
          default: "none",
        });
        expect(columnSummary(users, "age")).toEqual({
          sql: "age",
          type: types["age"],
          isNullable: true,
          default: expectedAgeDefault[provider],
        });
        expect(columnSummary(users, "active")).toEqual({
          sql: "active",
          type: types["active"],
          isNullable: false,
          default: expectedActiveDefault[provider],
        });
        expect(columnSummary(users, "parent_id")).toEqual({
          sql: "parent_id",
          type: types["parent_id"],
          isNullable: true,
          default: undefined,
        });

        for (const ormName of Object.keys(items.columns)) {
          expect([ormName, columnSummary(items, ormName)]).toEqual([
            ormName,
            {
              sql: ormName,
              type: types[ormName],
              isNullable: ormName !== "id" && ormName !== "owner_id",
              default: undefined,
            },
          ]);
        }

        // A named composite unique keeps its name; a column-level unique gets a
        // provider-generated name, so it is matched by its columns.
        const userUniques = users.getUniqueConstraints();
        expect(
          userUniques
            .find((con) => con.name === "intro_users_tag_age_uk")
            ?.columns.map((col) => col.ormName),
        ).toEqual(["tag", "age"]);
        expect(uniqueColumnNames(users)).toContainEqual(["nickname"]);
        expect(uniqueColumnNames(users)).toHaveLength(2);
        expect(uniqueColumnNames(items)).toEqual([]);

        expect(foreignKeySummary(users)).toEqual([
          {
            name: "intro_users_parent_fk",
            columns: ["parent_id"],
            referencedTable: "intro_users",
            referencedColumns: ["id"],
            onDelete: "RESTRICT",
            onUpdate: "RESTRICT",
          },
        ]);
        expect(foreignKeySummary(items)).toEqual([
          {
            name: "intro_items_owner_fk",
            columns: ["owner_id"],
            referencedTable: "intro_users",
            referencedColumns: ["id"],
            onDelete: "CASCADE",
            onUpdate: "CASCADE",
          },
        ]);

        // The foreign key becomes an explicit relation named after the constraint.
        expect(Object.keys(users.relations)).toEqual(["intro_users_parent"]);
        expect(Object.keys(items.relations)).toEqual(["intro_items_owner"]);
      }),
    { timeout: 120_000 },
  );

  it.live(
    `diffs a matching database against migrateV2: ${provider}`,
    () =>
      Effect.gen(function* () {
        const result = yield* withProvider(
          provider,
          Effect.gen(function* () {
            yield* runDdl(migrateV2Ddl[provider]);
            const matching = yield* diffAgainstMigrateV2(provider, true);

            // An extra database column is only dropped when it is allowed.
            yield* runDdl([alterUsers[provider].add]);
            const keepExtra = yield* diffAgainstMigrateV2(provider, false);
            const dropExtra = yield* diffAgainstMigrateV2(provider, true);

            // A column the database is missing is created.
            yield* runDdl([alterUsers[provider].dropExtra, alterUsers[provider].dropName]);
            const missing = yield* diffAgainstMigrateV2(provider, false);

            return { matching, keepExtra, dropExtra, missing };
          }),
        );

        expect(result.matching).toEqual([]);
        expect(result.keepExtra).toEqual([]);
        expect(columnOperations(result.dropExtra, "users")).toEqual([
          { type: "drop-column", name: "extra_col" },
        ]);

        const created = columnOperations(result.missing, "users").flatMap((op) =>
          op.type === "create-column" ? [op.value] : [],
        );
        expect(created.map((col) => col.names.sql)).toEqual(["name"]);
        expect(created[0]?.type).toBe("varchar(255)");
        expect(result.missing.every((op) => op.type === "update-table")).toBe(true);
      }),
    { timeout: 120_000 },
  );

  it.live(
    `reads every kind of default back unchanged: ${provider}`,
    () =>
      Effect.gen(function* () {
        const result = yield* withProvider(
          provider,
          Effect.gen(function* () {
            yield* runDdl(defaultsDdl[provider]);
            const introspected = yield* introspectSchema({
              provider,
              // The database types alone cannot say whether an integer is a
              // timestamp or a bool, so read each column as the target declares it.
              columnTypeMapping: (_dataType, { columnName }) =>
                defaultsStorageTypes[columnName] ?? "string",
            });
            const operations = yield* generateMigrationFromDatabase(
              defaultsSchema,
              configOf(provider),
              {
                nameVariants: undefined,
                dropUnusedColumns: true,
                internalTables: [],
              },
            );
            return { introspected, operations };
          }),
        );

        const defaults = getTable(result.introspected, "intro_defaults");
        expect(columnSummary(defaults, "ts").default).toEqual(defaultMoment);
        expect(columnSummary(defaults, "d").default).toEqual(defaultMoment);
        expect(columnSummary(defaults, "big").default).toEqual(defaultBigInt);
        expect(columnSummary(defaults, "q").default).toEqual(defaultQuoted);
        expect(columnSummary(defaults, "n").default).toEqual(21);
        expect(columnSummary(defaults, "flag").default).toEqual(true);

        // The property that matters: a database FumaDB itself wrote produces no
        // migration, so a from-database migration converges.
        expect(result.operations).toEqual([]);
      }),
    { timeout: 120_000 },
  );
}

// ---------------------------------------------------------------------------
// SQLite date defaults, round-tripped through the DDL this package generates
// ---------------------------------------------------------------------------

/** A moment with a time-of-day part, so a truncating round trip would show. */
const epochMoment = new Date("2020-01-02T03:04:05.678Z");

/** SQLite keeps a `date` and a `timestamp` as epoch milliseconds. */
const epochStorageTypes: Record<string, StorageType> = {
  id: "varchar(255)",
  d: "date",
  ts: "timestamp",
};

const epochSchema = makeSchema({
  version: "1.0.0",
  tables: {
    intro_epoch: makeTable("intro_epoch", {
      id: idColumn("id", Schema.String.check(Schema.isMaxLength(255))),
      d: makeColumn("d", Schema.NullOr(Schema.Date), { type: "date" }).default(epochMoment),
      ts: makeColumn("ts", Schema.NullOr(Schema.Date)).default(epochMoment),
    }),
  },
});

if (providers.includes("sqlite")) {
  it.live(
    "reads a sqlite date default back out of the DDL this package generated",
    () => {
      const config = configOf("sqlite");
      const statements = Result.getOrThrow(
        renderStatements(
          [{ type: "create-table", value: getTable(epochSchema, "intro_epoch") }],
          config,
        ),
      );

      return Effect.gen(function* () {
        const result = yield* withProvider(
          "sqlite",
          Effect.gen(function* () {
            yield* runDdl(statements);
            const introspected = yield* introspectSchema({
              provider: "sqlite",
              // An `integer` column could be an integer, a bigint, a bool, a
              // timestamp, or a date; read each one as the schema declares it.
              columnTypeMapping: (_dataType, { columnName }) =>
                epochStorageTypes[columnName] ?? "string",
            });
            const operations = yield* generateMigrationFromDatabase(epochSchema, config, {
              nameVariants: undefined,
              dropUnusedColumns: true,
              internalTables: [],
            });
            return { introspected, operations };
          }),
        );

        // The default really is the epoch-millisecond literal `src/sql/ddl.ts` writes.
        expect(statements.join("\n")).toContain(`default ${epochMoment.getTime()}`);

        const epoch = getTable(result.introspected, "intro_epoch");
        // a `date` keeps only the UTC calendar day; a `timestamp` keeps the instant
        expect(columnSummary(epoch, "d").default).toEqual(new Date("2020-01-02T00:00:00Z"));
        expect(columnSummary(epoch, "ts").default).toEqual(epochMoment);

        // The property that matters: the default is not re-emitted on every run.
        expect(result.operations).toEqual([]);
      });
    },
    { timeout: 120_000 },
  );
}
