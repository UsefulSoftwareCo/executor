# Writing an adapter

An adapter binds FumaDB to one storage technology. This package ships one,
`sqlAdapter`, over Effect SQL. The contract is `Adapter<R>`, exported from `fumadb-effect`:

```ts
interface Adapter<R> {
  readonly name: string;
  readonly createOrm: (context: AdapterContext, schema: AnySchema) => Orm<AnySchema, R>;
  readonly getSchemaVersion: (context: AdapterContext) => Effect<Option<string>, SqlError, R>;
  readonly createMigrator: ((context: AdapterContext) => Migrator<R>) | undefined;
}
```

`R` is whatever environment your operations need. Consumers provide it with a
`Layer` when they run the library's effects.

## The query side

Implement `OrmAdapter<R>` and wrap it with `toOrm`, both exported from `fumadb-effect/query`.
`toOrm` resolves table names, folds constant `where` conditions, and compiles
joins. Your adapter receives resolved `AnyTable` values and a `Condition` tree.

Every method returns an `Effect` failing with `SqlError | QueryError`. Use
`QueryError` for input the schema cannot satisfy and for undecodable results;
keep driver failures as `SqlError`.

Value encoding is the adapter's job. `serialize` and `deserialize` from
`fumadb-effect/schema` run a value through the column's Effect schema and
then the SQL provider matrix (`toDriver` / `fromDriver`); a non-SQL adapter
encodes through `column.schema` and its own representation.

For providers without real foreign keys, wrap the adapter with
`createSoftForeignKey(schema, adapter)` from `fumadb-effect/query`.

## The migration side

Use `createMigrator` from `fumadb-effect/migration`. Supply:

- `settings`: how to read the stored version and name variants, and the
  operations that write them.
- `executor`: how to apply `MigrationOperation`s. Run them atomically.
- `toSql` (optional): render operations as a script.
- `generateMigrationFromDatabase` (optional): introspection for
  `mode: "from-database"`.
- `transformers` (optional): rewrite operation lists, as the SQLite
  transformer does.
