## App data

Use the same author schemas for scalar database columns. Declare requirements once, derive `QueryContext<typeof requirements>` and
`MutationContext<typeof requirements>`, and use the standalone `query` and
`mutation` functions. External handlers annotate their context; inline handlers
infer it from `defineApp`. Input and output types remain inferred from schemas.

```ts
import {
  query,
  mutation,
  type QueryContext,
  type MutationContext,
  defineApp,
  defineDatabase,
  json,
  object,
  string,
  table,
} from "apps";

const database = defineDatabase({
  messages: table({ mailbox: string(), subject: string() }).index("by_mailbox", ["mailbox"]),
});
const requirements = { accounts: {}, database };
const list = query(
  { input: object({ mailbox: string() }), output: json() },
  async ({ db }: QueryContext<typeof requirements>, { mailbox }) =>
    db.messages
      .withIndex("by_mailbox", (q) => q.eq("mailbox", mailbox))
      .order("desc")
      .take(50),
);
const add = mutation(
  { input: object({ mailbox: string(), subject: string() }), output: json() },
  async ({ db }: MutationContext<typeof requirements>, message) => db.messages.insert(message),
);
export default defineApp(requirements, {
  queries: { list },
  mutations: { add },
});
```

Queries and mutations are automatically available to the agent as `queries.<name>`
and `mutations.<name>` in the app's tool catalog. Use `tools.search` to get their
exact callable expressions; do not write another tool wrapper. Calls preserve
read-only query capability, atomic mutation commit, output validation and live
updates. Add `description` and optionally `title` to an operation's options to
improve discovery. Agent paths nest these categories under the name-derived app slug,
for example `tools.inbox.queries.list(...)`.

`defineDatabase` supplies only the schema; `database.query` and `database.mutation`
are removed. Declaring a database gives every query a read session and every
mutation a write transaction. Interactive elicitation is unavailable during those
transactions. Browser clients can subscribe with query references/live atoms.

Use a concrete output schema instead of `json()` when you want inferred client
result fields. Each configured app has its own database, retained across code
updates. Never supply row metadata on writes: the host creates `id`, `createdAt`
and `updatedAt`. Tables also provide `get`, `update` and `delete`. Queries have
read methods only. Optional fields support `null` to clear them; defaults apply
when values are omitted. An undefined patch property leaves the value unchanged.

Index queries support prefix `eq` terms, then `gt`/`gte`/`lt`/`lte` bounds on the
next field. Use `by_creation` without declaring an index. Terminals include
`first`, `take`, `collect`, `count` and `paginate({ cursor, numItems })`. A page
returns `page`, `continueCursor`, and `isDone`. Pass the returned cursor unchanged.

Reads are bounded: 5,000 rows scanned, 1,000 rows returned, and 4 MiB per
invocation. `collect` and `count` fail instead of truncating. Mutations allow
1,000 writes and commit only after output validation. External fetch is allowed in queries and mutations, but network waits inside
database callbacks keep their transaction open. Schema changes currently fail
closed; an explicit migration flow is not implemented yet. Rebuild old prototype
apps using `defineTable`/`db.set` for this API; no legacy-data migration is included.

## Read and write results

`insert(value)` returns the complete inserted row, including `id`, `createdAt`
and `updatedAt`. `get(id)` returns a row or `null`. `update(id, patch)` returns
the updated row or `null` when the row does not exist. `delete(id)` returns a boolean. Read `DatabaseTable.insert`,
`DatabaseTable.update`, and `IndexQuery` through `framework_describe` for exact types.
Do not deploy probe apps to discover these contracts.
