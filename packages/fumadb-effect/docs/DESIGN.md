# fumadb-effect design

An Effect-native port of [fumadb](https://github.com/fuma-nama/fumadb) (v0.6.0).
Imported from source revision `cc84f64911ce9b4f23cc3ae49711281b195ba3ca`.
This workspace uses Executor's pinned Effect v4 snapshot; consult the root
`AGENTS.md` and `.reference/effect-v4/` for its API reference.

## Goal

The same product as fumadb for library authors: a unified schema, a Prisma-like
query interface with relations, and a safe SQL migrator, so a library can ship
database features without knowing what database the consumer runs. The
implementation is Effect v4 all the way down: every operation returns an
`Effect`, failures are typed values, the database is a service in `R`, and
transactions use Effect SQL's fiber-scoped transaction connection.

## What is in scope

- `schema`: tables, columns, id columns, relations, unique constraints,
  variant schemas, name variants (upstream `schema/*`).
- `query`: condition builder, ORM abstraction (`Orm<S, R>`), joins, upsert,
  soft foreign-key engine (upstream `query/*`).
- `sql`: the single shipped adapter, built on `effect/unstable/sql`
  `SqlClient`. Supports `postgresql`, `cockroachdb`, `mysql`, `sqlite`,
  `mssql` (upstream `adapters/kysely/*`).
- `migration`: schema diff, migrator engine, DDL generation per provider,
  database introspection (`from-database` mode), SQLite table-recreate
  transformer (upstream `migration-engine/*` + `adapters/kysely/migration/*`).
- `cli`: an `effect/unstable/cli` command tree mirroring upstream `cli/`.

## What is out of scope (deliberately)

- Drizzle, Prisma, TypeORM, MongoDB, and Convex adapters and code generators.
  Those bridge other ORMs. In Effect the database bridge is `SqlClient`. The
  `Adapter<R>` interface stays open so more adapters can be added.
- The soft transaction polyfill (upstream `query/polyfills/transaction.ts`).
  Every shipped provider has real transactions through `sql.withTransaction`.

## Schema-first tables

Columns are Effect schemas (`docs/SCHEMA-FIRST.md`). `column(name, schema)`
infers the storage type from the schema's encoded AST (`schema/storage.ts`),
`table()` derives `row`, `insert`, and `update` `Schema.Struct`s, and the
codec runs every value through the column schema (`serialize` encodes, then
applies the provider encoding; `deserialize` reverses it). Upstream's string
type names (`"varchar(255)"`, `"string"`, ...) survive as the `StorageType`
union used by DDL, diffing, and introspection; `{ type }` on a column
overrides the inference.

## Public API

```ts
import { fumadb } from "fumadb-effect"
import { column, idColumn, schema, table, variantSchema } from "fumadb-effect/schema"
import { sqlAdapter } from "fumadb-effect/sql"

const v1 = schema({ version: "1.0.0", tables: {...}, relations: {...} })
const ChatDB = fumadb({ namespace: "fuma-chat", schemas: [v1] })

// consumer side
const client = ChatDB.names.prefix("chat_").client(sqlAdapter({ provider: "postgresql" }))

// library side; R = SqlClient.SqlClient for the sql adapter
const program = Effect.gen(function* () {
  const version = yield* client.version          // Effect<"1.0.0", NotInitialized | SqlError, R>
  const orm = client.orm(version)                // Orm<typeof v1, R>
  const users = yield* orm.findMany("users", {   // Effect<Row[], SqlError | QueryError, R>
    select: ["name"],
    where: (b) => b.and(b.isNotNull("name"), b("id", "=", "test")),
    join: (b) => b.messages({ limit: 1 }),
  })
  yield* orm.transaction(Effect.gen(function* () { ... }))   // sql.withTransaction
})
```

### Generics

- `Adapter<R>`, `FumaDB<Schemas, R>`, `Orm<S, R>`, `Migrator<R>` carry the
  environment the adapter needs. `sqlAdapter(...)` yields `R = SqlClient.SqlClient`.
- `InferFumaDB<Factory, R = SqlClient.SqlClient>` for library authors who
  target the SQL adapter (the default), or `<Factory, R>` when polymorphic.

### Errors (all `Schema.TaggedError`)

| Error                   | When                                                                                                                                                                          | Fields      |
| ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------- |
| `SqlError` (Effect SQL) | driver failure; soft-FK violations are raised as `SqlError` with a `ConstraintError` reason so relation mode never changes the error type                                     |             |
| `QueryError`            | `reason: "UnknownTable" \| "UnknownColumn" \| "InvalidInput" \| "MissingIdValue" \| "NoMatchingRow" \| "UnexpectedResult" \| "Decode"`, `message`, optional `table`, `column` |             |
| `NotInitialized`        | `client.version` when the settings table or version row is absent                                                                                                             | `namespace` |
| `MigrationError`        | `reason: "AlreadyUpToDate" \| "NoPrevious" \| "UnknownVersion" \| "Unsupported" \| "Introspection" \| "Execution"`, `message`, optional `cause`                               |             |
| `SchemaDefinitionError` | thrown (defect) at schema construction: invalid definitions are programmer errors                                                                                             | `message`   |

### Orm<S, R>

```ts
interface Orm<S extends AnySchema, R> {
  readonly schema: S
  readonly transaction: <A, E, R2>(effect: Effect<A, E, R2>) => Effect<A, E | SqlError, R | R2>
  readonly count: (table, { where? }?) => Effect<number, OrmError, R>
  readonly findFirst: (table, options) => Effect<Row | null, OrmError, R>
  readonly findMany: (table, options?) => Effect<Row[], OrmError, R>
  readonly create: (table, values) => Effect<Row, OrmError, R>
  readonly createMany: (table, values[]) => Effect<{ _id: unknown }[], OrmError, R>
  readonly updateMany: (table, { where?, set }) => Effect<void, OrmError, R>
  readonly deleteMany: (table, { where? }) => Effect<void, OrmError, R>
  // overloads: `returning: true` returns the row, otherwise void
  readonly upsert: (table, { where, create, update, returning? }) => Effect<Row | void, OrmError, R>
}
type OrmError = SqlError | QueryError
```

Upstream's lazy `UpsertQuery.forceReturning()` becomes the `returning: true`
option because Effects are already lazy.

### Migrator<R>

```ts
interface Migrator<R> {
  readonly version: Effect<Option<string>, SqlError, R>
  readonly nameVariants: Effect<Option<NameVariantsConfig>, SqlError, R>
  readonly next: Effect<Option<AnySchema>, SqlError, R>
  readonly previous: Effect<Option<AnySchema>, SqlError, R>
  readonly up: (options?: MigrateOptions) => Effect<MigrationResult<R>, MigrationError | SqlError, R>
  readonly down: ...
  readonly migrateTo: (version: string, options?) => ...
  readonly migrateToLatest: (options?) => ...
}
interface MigrationResult<R> {
  readonly operations: ReadonlyArray<MigrationOperation>
  readonly sql: Option<string>                        // full SQL script, `;` separated like upstream getSQL()
  readonly execute: Effect<void, MigrationError | SqlError, R>
}
```

Custom `up`/`down` on a schema: `(context: { auto: Effect<ops, MigrationError | SqlError> }) => Effect<ops, MigrationError | SqlError>`.
The migrator provides its own environment to `auto`, so custom functions stay R-free.

## Module layout

```text
src/
  contracts/
    adapter.ts, database.ts, errors.ts, provider.ts
    query.ts, query-adapter.ts, condition.ts
    migration.ts, migration-operation.ts, sql.ts
    names.ts, version.ts
    schema/                 columns, tables, relations and schema definitions
  implementation/
    database.ts, cuid.ts, schema-codec.ts, cli.ts
    query/                  query compiler and foreign-key engine
    migration/              diff and migration planner
    sql/                    Effect SQL queries, DDL, codecs and introspection
  index.ts                  database factory and public types
  schema.ts, query.ts, migration.ts, sql.ts, adapter.ts, cli.ts
```

Examples live in `playground/fumadb-effect/` at the repository root and import
package exports. The original tests and SQL snapshots are retained in `test/`.

## Conventions

- Effect v4 names: `Effect.catch` (not catchAll), `Effect.catchCause`,
  `Schema.TaggedError<Self>(id)(tag, fields)`, `Effect.fn("FumaDB.op")` for
  public operations, `Effect.fnUntraced` for internal helpers,
  `Data.TaggedEnum` for internal algebras.
- Absent values: the migrator surface (`version`, `next`, `previous`,
  `nameVariants`, `MigrationResult.sql`) uses `Option`. The query surface
  (`findFirst`, `one` joins) uses `null`, matching Prisma and upstream fumadb,
  because those values are the row shape a library author passes on.
- The client is a plain value, not a service. `sqlAdapter()`, `.client()`,
  `.names(...)`, and `makeCli()` perform no I/O; a library exposes the
  effects it builds from the client, and the consumer provides the
  `SqlClient` layer. `client.version` queries the settings table each time;
  see `client.cachedVersion` for a memoised read.
- `tsconfig` has `noUncheckedIndexedAccess` and `exactOptionalPropertyTypes`.
  Never use `!` or `as any`. Use `getColumn(table, name)` / `getTable(...)`
  helpers that raise `SchemaDefinitionError` for invariants the schema
  validated at construction, and typed `QueryError` for runtime lookups.
- Identifiers always go through `sql(name)` so each driver escapes them.
  Values always go through parameters, except DDL and settings statements,
  which are literal SQL text (like upstream) so `MigrationResult.sql` is a
  runnable script.
- Value codec matrix (`schema/codec.ts`) is the single place that knows how a
  provider represents each column type. See the table in that file.
- Tests: none in this package; Executor is tested only through `e2e/`.

## Deliberate deviations from upstream

1. `NameVariants` is `{ sql: string }`. The drizzle/prisma/convex/mongodb
   variants existed for adapters that are not part of this package.
2. `defaultTo$` also accepts an `Effect`; `"now"` reads `Clock`, so tests can
   use `TestClock`.
3. `contains` / `starts with` / `ends with` escape LIKE wildcards
   (`%`, `_`, and `[` on MSSQL) with an explicit `ESCAPE` clause. Upstream
   passed user text straight into the pattern.
4. `client.version` does not swallow driver errors. Upstream returned
   `undefined` on any failure. We check that the settings table exists, then
   read it; a genuine connection error stays an `SqlError`.
5. MSSQL upsert without `returning` uses `OUTPUT INSERTED.<id>` to learn
   whether the update matched, because the Effect driver's `.raw` does not
   expose a row count.
6. The CLI logs upstream's "Already up to date." and "Cannot downgrade."
   notices to `Console` and then fails with a typed `MigrationError`
   (`AlreadyUpToDate` / `NoPrevious`). Upstream printed the line and called
   `process.exit(1)`.
7. Soft foreign keys (`relationMode: "fumadb"`): a CASCADE delete and a
   CASCADE / SET NULL update re-enter the engine, so grandchildren are
   reached; upstream cleaned up one level and left grandchildren dangling.
   Because of that recursion an update cascade that reaches a RESTRICT key one
   level down now fails where upstream silently left the row dangling. A
   RESTRICT check ignores rows that the same operation deletes (SQL's
   statement-level NO ACTION rule). Cycles terminate through a visited set.
8. `generateMigrationFromSchema` on CockroachDB with `relationMode: "fumadb"`
   emits a plain `create-table`; upstream always split CockroachDB into
   `create-table` plus `add-foreign-key` and so created enforced foreign keys
   even when FumaDB was meant to enforce them.
9. `table()` rejects a second id column; upstream silently kept the last one.
10. `variantSchema()` re-points relations that target a replaced table at the
    replacement, and validation rejects a foreign key whose target is not
    part of the schema. Upstream emitted DDL referencing a table the
    migration never created.
11. `deserialize` does not re-parse JSON on PostgreSQL, CockroachDB, and
    MySQL because those drivers already parsed it; upstream re-parsed and so
    crashed on a stored JSON string. Malformed JSON text on SQLite and MSSQL
    is a typed `QueryError` (`Decode`) instead of a defect.
12. On MSSQL, inserts render `NULL` as a literal instead of a bound
    parameter: the Effect driver types every `null` parameter as `bit`, and a
    multi-row insert mixing `NULL` with text in one column fails.
13. Introspection on SQLite skips the primary key's autoindex (SQLite refuses
    to drop it) and recovers real foreign key names from `sqlite_master`;
    upstream synthesised `fk_<table>_<n>` names and so re-created every
    foreign key on each `from-database` migration. Date and timestamp defaults
    are read as UTC.
14. MSSQL text columns are `nvarchar`, because `varchar` is a single-byte
    codepage type and turns non-Latin1 text into `?`. MSSQL `timestamp` is
    `datetime2(3)` and MySQL `timestamp` is `datetime(3)`: `datetime` rounds
    to 3.33 ms ticks, and MySQL `timestamp` has second precision, a 1970 to
    2038 range, and depends on the session time zone. Dates and timestamps
    are sent as UTC text on MySQL and MSSQL, and a `date` read back is the
    UTC calendar day. `decimal` is `decimal(65,30)` on MySQL and
    `decimal(38,19)` on MSSQL and is bound as text, so every digit of a
    double survives. MSSQL `uuid` values are
    lower-cased on read.
15. MSSQL comparisons bind `NULL` as a literal (the driver types a null
    parameter as `bit`); `contains` and friends with a `null` value fail
    with `QueryError` (`InvalidInput`) instead of matching every row;
    column-to-column `contains` propagates `NULL` on MSSQL like elsewhere.
16. `createMany` splits a large batch into several statements under the
    provider's parameter limit and runs them in one transaction. A sub-query
    join uses an `IN` list over distinct keys (chunked) instead of one `OR`
    branch per root row, so joins work past 1000 roots on SQLite.
17. Joining the same relation twice is a compile error and a typed
    `QueryError`; upstream died with a `TypeError`.
18. An MSSQL `alter column` always restates the nullability; `toSql` returns
    a `Result` so an unrenderable plan fails the migration; MSSQL
    `drop column` drops the column's default constraint first; SQLite
    introspection ignores the primary key's autoindex, reads epoch-millisecond
    date defaults, and recreates a table to drop a default; MSSQL
    introspection reads `sys.default_constraints` and returns columns in
    creation order; MSSQL offset queries without `orderBy` are ordered by the
    id column because T-SQL requires `ORDER BY` with `OFFSET`.
19. Upstream produced invalid SQL or wrong results in these cases and the
    port does not: empty `in` / `not in`; `is` / `is not` with a non-null
    value; per-element serialisation of `in` lists; a join's `where`
    rendered against the join alias; `offset` without `limit` on MySQL and
    SQLite; `limit` with `offset` on MSSQL; `RETURNING` on CockroachDB;
    empty `createMany` / `updateMany` / `upsert` updates; a never-matching
    join yielding `null` / `[]` instead of an absent key; a sub-record shared
    by two parents attached to both.
20. Definition-time guards: `unique()` and `table.unique()` reject unbounded
    `string`, `json`, and `binary` columns, and a foreign key must join
    columns of the same storage type (a referencing column adopts the
    referenced key's width when its own type was inferred). MySQL and SQL
    Server cannot index unbounded text, so these are errors rather than
    provider-specific failures at migration time.
21. `date` columns keep only the UTC calendar day on every provider,
    including SQLite (epoch milliseconds of the day) and in DDL defaults.
    MySQL `now()` defaults render as `CURRENT_TIMESTAMP(3)` to match the
    `datetime(3)` column.
22. A `bigint` outside the signed 64-bit range is a typed `InvalidInput`
    before it reaches any driver; a stored SQLite bigint blob that is not 8
    bytes is a typed `Decode` failure.
23. LIKE fragments (`contains`, `starts with`, `ends with`) are plain text and
    are not validated as whole values of a refined column; `Option.none()` in
    a `where` compares like `null`.
24. SQLite introspection ranks `text` as `string` and `integer` as `integer`
    first (upstream ranked `json` and `bool` first), so an introspected column
    can always read its own data.
25. Join keys and soft-foreign-key comparisons use structural equality
    (`Equal.equals`), so a relation joined on a `DateTime` or byte column
    matches; `Option.none()` counts as an absent join value.
26. Tables are Schema-first: a column takes an Effect schema instead of a
    type name, `.nullable()` is `Schema.NullOr`, `defaultTo$("auto")` is
    `.generated()`, `defaultTo$("now")` is `.now()`, `defaultTo(v)` is
    `.default(v)`, and `.generate(effect)` replaces function defaults. Values
    are validated against the column schema on the way in (`InvalidInput`)
    and out (`Decode`), so a stored value that no longer matches the schema
    is a typed failure, and branded ids, literal unions, `DateTime`, and
    nested structs flow through queries with their precise types.
27. `upstream bugs fixed in passing`: `variantSchema` no longer duplicates
    every foreign key; `names([versions], variants)` keeps the schemas outside
    the version list; `Table.clone()` keeps an applied name override;
    `fumadb()` does not mutate the caller's schema array.

## Known limitations

- **MSSQL parallel transactions.** Two concurrent `orm.transaction(...)`
  calls that read and write the same table can be chosen as a deadlock victim
  by SQL Server. The Effect MSSQL driver (rc.115) then issues a `ROLLBACK`
  for a transaction the server already rolled back, and that second failure
  surfaces as a defect ("The ROLLBACK TRANSACTION request has no
  corresponding BEGIN TRANSACTION"). Reproduced with the raw driver in
  `.scratch` during integration; it is a driver behaviour, not something this
  package can fix. Serialise transactions on MSSQL, or retry on
  `SqlError` with a `DeadlockError` reason.
- **DDL atomicity.** A failed migration is rolled back on PostgreSQL, SQLite,
  and MSSQL. MySQL and CockroachDB commit DDL implicitly, so a migration that
  fails halfway leaves the statements before the failure applied; the settings
  table is only written at the end, so a retry starts from the stored version.
- **Soft foreign keys race.** `relationMode: "fumadb"` checks and writes in
  a transaction but does not lock the referenced rows, so a concurrent delete
  of the parent between the check and the insert is not prevented. Upstream has
  the same window; a real foreign key does not.
