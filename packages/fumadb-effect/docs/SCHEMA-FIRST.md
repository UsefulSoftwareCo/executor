# Schema-first tables

Tables are defined with `effect/Schema`. A column is an Effect schema plus
storage metadata; the row types, insert types, update types, and the value
codec all derive from the schema.

## Defining a table

```ts
import { Schema } from "effect";
import { column, idColumn, schema, table } from "fumadb-effect/schema";

const UserId = Schema.String.pipe(Schema.brand("UserId"));
// bounded, so it can be unique: MySQL and SQL Server cannot index unbounded text
const Email = Schema.String.check(Schema.isMaxLength(255), Schema.isPattern(/@/));

const users = table("users", {
  id: idColumn("id", UserId).generated(), // varchar(255), CUID2 on insert
  name: column("name", Schema.String), // text
  email: column("email", Schema.NullOr(Email)).unique(), // varchar(255), nullable
  age: column("age", Schema.Int).default(0), // integer, database default
  createdAt: column("created_at", Schema.DateTimeUtcFromDate).now(),
  settings: column("settings", Schema.Struct({ theme: Schema.String })), // json
  avatar: column("avatar", Schema.NullOr(Schema.Uint8Array)), // binary
});
```

### How the storage type is chosen

`column(name, schema)` inspects `Schema.toEncoded(schema)`, so brands,
refinements, and transformations (such as `DateTimeUtcFromDate`) do not
change the stored representation. The encoded AST maps to a storage type:

| Encoded AST                                    | storage type                 |
| ---------------------------------------------- | ---------------------------- |
| `String` with `isMaxLength(n)`                 | `varchar(n)`                 |
| `String` with `isUUID()`                       | `uuid`                       |
| `String`                                       | `string`                     |
| `Number` with `isInt()`                        | `integer`                    |
| `Number`                                       | `decimal`                    |
| `BigInt`                                       | `bigint`                     |
| `Boolean`                                      | `bool`                       |
| `Date` declaration                             | `timestamp`                  |
| `Uint8Array` declaration                       | `binary`                     |
| anything else (`Struct`, `Array`, `Unknown`)   | `json`                       |
| `NullOr(X)` / union with `Null` or `Undefined` | nullable X                   |
| `Literals([...])` of one kind                  | that kind                    |
| `OptionFromNullOr(X)`                          | nullable X, read as `Option` |

`Schema.Option(X)` is rejected: its encoded form is still an `Option`. Use
`Schema.OptionFromNullOr(X)` for a nullable column that reads as an `Option`.
`Schema.optionalKey` / `Schema.optional` are rejected too; a column is always
present in a row.

Override the inference when the default is wrong: `column("d", Schema.Date, { type: "date" })`
or `column("code", Schema.String, { type: "varchar(32)" })`.

`idColumn` accepts a schema whose storage type is `varchar(n)` or `uuid`; a
plain `Schema.String` (or a brand of it) becomes `varchar(255)`.

A column that references an id through a foreign key adopts the id's storage
type when its own type was inferred, so `column("author", UserId)` is stored
as `varchar(255)` like `idColumn("id", UserId)`. An explicit `{ type }` is
kept, and a mismatch between the two sides throws `SchemaDefinitionError`
(MySQL cannot index unbounded text).

### Defaults

- `.default(value)` stores a constant default in the database and applies it
  on insert. The value is given on the schema's `Type` side (a `DateTime`
  for a `DateTimeUtcFromDate` column); it is encoded once at definition time,
  and the encoded value is what DDL writes and the migration diff compares.
  A value the schema rejects throws `SchemaDefinitionError`.
- `.generated()` generates a UUID v4 for a `uuid` column and a CUID2 for any
  other string column; the value is decoded through the column schema.
- `.now()` reads the clock for date and timestamp columns and decodes the
  instant through the column schema, so the value has the schema's `Type`.
- `.generate(effect)` runs an `Effect` on every insert.

A column with a default is optional on insert.

## Derived schemas

Every table exposes:

- `table.row`: `Schema.Struct` of a selected row (`Type` side is the decoded
  value, `Encoded` side is the driver representation).
- `table.insert`: the row with defaulted and nullable columns optional.
- `table.update`: every column optional, the id column omitted.

These are `Schema.Struct`s and compose with the rest of Effect: `mapFields`,
JSON Schema, arbitraries, HTTP contracts.

## Codec

The query adapter encodes values with `Schema.encodeUnknownResult(column.schema)`
and then applies the provider-specific storage encoding (SQLite epoch
milliseconds, MSSQL null literals, and so on), and decodes in the reverse
order. A value the schema rejects fails with `QueryError` (`Decode`) on the
way out and `QueryError` (`InvalidInput`) on the way in.
