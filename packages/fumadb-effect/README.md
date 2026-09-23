# fumadb-effect

An [Effect](https://effect.website) v4 port of [fumadb](https://github.com/fuma-nama/fumadb): a unified schema, a Prisma-like query interface with relations, and a safe SQL migrator, so a library can ship database features without knowing which database its consumer runs.

Everything is Effect-native. Operations return `Effect`, failures are typed values, the database is a service in the environment, and transactions use Effect SQL's fiber-scoped transaction connection.

Supported through Effect SQL: PostgreSQL, CockroachDB, MySQL, SQLite, and Microsoft SQL Server.

## Workspace package

Executor uses this source directly through `"fumadb-effect": "workspace:*"`.
It shares the repository's pinned Effect v4 snapshot. No build or tarball is
needed for local development.

The source was imported from `fumadb-effect` revision
`cc84f64911ce9b4f23cc3ae49711281b195ba3ca`. The MIT license and upstream
attribution are retained in [LICENSE](LICENSE).

- `src/contracts/`: schemas, errors, query and migration contracts.
- `src/implementation/`: database factory, SQL adapter, migration engine and CLI.
- `src/index.ts` and sibling entry points: public package exports.
- [Playground](../../playground/fumadb-effect/): consumer and library examples.

Node 24 or newer.

## Library author

Define one schema per version. Schemas are immutable once published; add a new version to change them.

Columns are Effect schemas. The stored type is inferred from the schema's encoded side, so brands, refinements, and transformations never change the DDL.

```ts
// schema/v1.ts
import { Schema } from "effect";
import { column, idColumn, schema, table } from "fumadb-effect/schema";

export const UserId = Schema.String.pipe(Schema.brand("UserId"));

export const v1 = schema({
  version: "1.0.0",
  tables: {
    users: table("users", {
      id: idColumn("id", UserId).generated(), // varchar(255), CUID2 on insert
      name: column("name", Schema.String), // text
      email: column("email", Schema.NullOr(Schema.String.check(Schema.isMaxLength(255)))).unique(),
      createdAt: column("created_at", Schema.DateTimeUtcFromDate).now(),
    }),
    messages: table("messages", {
      id: idColumn("id", Schema.String).generated(),
      user: column("user", UserId),
      content: column("content", Schema.String).default(""),
      meta: column("meta", Schema.Struct({ pinned: Schema.Boolean })), // json
    }),
  },
  relations: {
    users: ({ many }) => ({ messages: many("messages") }),
    messages: ({ one }) => ({ author: one("users", ["user", "id"]).foreignKey() }),
  },
});
```

| Encoded schema                               | Stored as    |
| -------------------------------------------- | ------------ |
| `Schema.String`                              | `string`     |
| `Schema.String.check(Schema.isMaxLength(n))` | `varchar(n)` |
| `Schema.String.check(Schema.isUUID())`       | `uuid`       |
| `Schema.Int`                                 | `integer`    |
| `Schema.Number`                              | `decimal`    |
| `Schema.BigInt`                              | `bigint`     |
| `Schema.Boolean`                             | `bool`       |
| `Schema.Date` (or `DateTimeUtcFromDate`)     | `timestamp`  |
| `Schema.Uint8Array`                          | `binary`     |
| anything else (structs, arrays, unions)      | `json`       |

Wrap a schema in `Schema.NullOr` for a nullable column. A unique or foreign-key column needs a bounded type (`varchar(n)`, `uuid`, a number, a date): MySQL and SQL Server cannot index unbounded text. Pass `{ type: "date" }` (or any storage type) as the third argument to override the inference. `.default(v)` stores a constant, `.generated()` makes a CUID2, `.now()` reads the clock, `.generate(effect)` runs your own Effect.

Every table exposes `table.row`, `table.insert`, and `table.update` as `Schema.Struct`s, so the same definitions serve HTTP contracts, JSON Schema, and tests.

Create the factory. The `namespace` must never change after publishing.

```ts
// db.ts
import { fumadb } from "fumadb-effect";
import { v1 } from "./schema/v1";

export const ChatDB = fumadb({ namespace: "fuma-chat", schemas: [v1] });
```

Query through the client the consumer gives you. Every method is an `Effect` that fails with `SqlError` or `QueryError` and needs `SqlClient.SqlClient`.

```ts
import { Effect } from "effect";
import type { InferFumaDB } from "fumadb-effect";
import type { ChatDB } from "./db";

export const getUser = (client: InferFumaDB<typeof ChatDB>) =>
  Effect.gen(function* () {
    const version = yield* client.version;
    const orm = client.orm(version);
    return yield* orm.findFirst("users", {
      select: ["name"],
      where: (b) => b.and(b.isNotNull("name"), b("id", "=", "test")),
      join: (b) => b.messages({ limit: 5 }),
    });
  });
```

Operations: `count`, `findFirst`, `findMany`, `create`, `createMany`, `updateMany`, `deleteMany`, `upsert` (with `returning: true` to get the row back), and `transaction(effect)`.

`findFirst` and a `one` join return `null` when there is no row, like Prisma. `client.version` reads the settings table on every call; in a long-lived program build `const version = yield* client.cachedVersion` once and reuse it.

## Consumer

Bind the SQL adapter and provide an Effect SQL client layer.

```ts
import { Effect, Layer, Redacted } from "effect";
import { PgClient } from "@effect/sql-pg";
import { sqlAdapter } from "fumadb-effect/sql";
import { ChatDB } from "your-library";

const client = ChatDB.names.prefix("chat_").client(sqlAdapter({ provider: "postgresql" }));

const Database = PgClient.layer({ url: Redacted.make(process.env.DATABASE_URL!) });

// migrate to the latest schema version
const migrate = Effect.gen(function* () {
  const migrator = yield* client.createMigrator;
  const result = yield* migrator.migrateToLatest();
  yield* result.execute;
});

Effect.runPromise(migrate.pipe(Effect.provide(Database)));
```

Table and column names can be overridden with `ChatDB.names({ messages: { sql: "chat_messages" } })` or prefixed with `ChatDB.names.prefix("chat_")`. Migrate after changing names.

## Migrations

The migrator diffs schema versions (`mode: "from-schema"`, default) or introspects the database (`mode: "from-database"`). It supports creating and dropping tables, foreign keys, and unique constraints, and renaming tables and adding, updating, renaming, and dropping columns. On SQLite, column updates recreate the table and copy the data. Each migration runs in one transaction. `result.sql` renders the same migration as a script.

## CLI

`fumadb-effect/cli` builds an `effect/unstable/cli` command tree with `migrate:up`, `migrate:down`, `migrate:to [version]` (alias `migrate`), and `generate [version] --output <path>`.

```ts
// scripts/chat.ts (consumer side)
import { NodeRuntime, NodeServices } from "@effect/platform-node";
import { Effect } from "effect";
import { makeCli } from "fumadb-effect/cli";
import { client, Database } from "./lib/chat";

const cli = makeCli({ db: client, command: "chat", version: "1.0.0" });

cli.run().pipe(Effect.provide(Database), Effect.provide(NodeServices.layer), NodeRuntime.runMain);
```

Run it with `node scripts/chat.ts migrate:to latest`. Without a version, `migrate:to` prompts for one.

## Errors

Every failure is a typed value in the error channel:

- `SqlError` from Effect SQL for driver failures, including constraint violations (also from FumaDB's own foreign key engine).
- `QueryError` for bad query input or undecodable results, with a `reason` such as `UnknownTable`, `InvalidInput`, `NoMatchingRow`, or `Decode`.
- `NotInitialized` from `client.version` before the first migration.
- `MigrationError` for planning and execution failures, with `reason`, the failing `statement`, and its `cause`.

Invalid schema definitions throw `SchemaDefinitionError` when the schema is built.

## Development

From the repository root:

```sh
bun install
bun run --cwd packages/fumadb-effect typecheck
FUMADB_TEST_PROVIDERS=sqlite bun run --cwd packages/fumadb-effect test
```

For the full provider suite, start the package's Docker databases with
`bun run --cwd packages/fumadb-effect db:up`, then run its tests without
`FUMADB_TEST_PROVIDERS`. Use a separate `FUMADB_TEST_DATABASE` for concurrent runs.

## Differences from fumadb

See `docs/DESIGN.md`. In short: only the SQL adapter ships (Drizzle, Prisma, TypeORM, MongoDB, and Convex adapters are out of scope), `upsert().forceReturning()` is `upsert(..., { returning: true })`, name variants only carry `sql`, and LIKE patterns escape wildcards.

### PGlite

The optional `fumadb-effect/pglite` subpath exports `pgliteLayer({ dataDir })`.
Install the matching `@effect/sql-pglite` peer. This uses the native Effect driver
and leaves naive date/timestamp results as strings for FumaDB's UTC codec.
Without this configuration, PGlite parses them in the machine timezone. Use
`sqlAdapter({ provider: "postgresql" })`; there is no separate PGlite dialect.
