---
"@executor-js/fumadb": major
---

MySQL Drizzle schema generation now rejects unbounded string primary keys instead of emitting invalid `text` primary-key SQL. Before upgrading, change every MySQL `idColumn(..., "string")` to an explicit bound such as `idColumn(..., "varchar(255)")` (or use `"uuid"`). The `IdColumnType` type is now exported from `@executor-js/fumadb/schema` for reusable schema helpers.
