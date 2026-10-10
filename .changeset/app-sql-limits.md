---
"apps": patch
---

Migrations may end with comments: the host runs a migration up to its last
statement, which Durable Object SQLite requires, and still hashes the whole
file. `ctx.sql` refuses a statement that binds more than 100 values with an
error that names the limit and suggests `json_each(?)`, instead of SQLite's
"too many SQL variables".
