## App data

An app with SQL files in `migrations/` owns a SQLite database. Handlers read and
write it with plain SQL through `ctx.sql`. The migrations are the schema: the
host applies new ones when you deploy. Declare requirements once and derive
`QueryContext<typeof requirements>` and `MutationContext<typeof requirements>`.

```ts
import {
  query,
  mutation,
  type QueryContext,
  type MutationContext,
  defineApp,
  object,
  string,
  router,
} from "apps";

const requirements = { accounts: {} };
type Message = { id: string; subject: string };

const list = query(
  { input: object({ mailbox: string() }) },
  async ({ sql }: QueryContext<typeof requirements>, { mailbox }) =>
    sql
      .exec<Message>(
        "SELECT id, subject FROM messages WHERE mailbox = ? ORDER BY created_at DESC LIMIT 50",
        mailbox,
      )
      .toArray(),
);
const add = mutation(
  { input: object({ mailbox: string(), subject: string() }) },
  async ({ sql }: MutationContext<typeof requirements>, message) =>
    sql
      .exec<Message>(
        "INSERT INTO messages (id, mailbox, subject, created_at) VALUES (?, ?, ?, ?) RETURNING id, subject",
        crypto.randomUUID(),
        message.mailbox,
        message.subject,
        Date.now(),
      )
      .one(),
);
export default defineApp(requirements, { tools: router({ list, add }) });
```

`migrations/0001_messages.sql` creates the table:

```sql
CREATE TABLE messages (
  id TEXT PRIMARY KEY NOT NULL,
  mailbox TEXT NOT NULL,
  subject TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX messages_mailbox ON messages (mailbox, created_at);
```

Queries and mutations in the app's `tools` router are available to the agent by
their router path, such as `list` or `issues.list`. Use `tools.search` to get
their exact callable expressions; do not write another tool wrapper. Add
`description` and optionally `title` to improve discovery. Each configured app
has its own database, kept across deployments.

## `ctx.sql`

`ctx.sql` mirrors Cloudflare's Durable Object `SqlStorage`.

- `exec(query, ...bindings)` runs a statement and returns a cursor whose rows
  are already read: `toArray()`, `one()` (exactly one row, or it throws),
  iteration, `columnNames`, `rowsRead` and `rowsWritten`. Bind values with `?`;
  never build SQL from input strings. JavaScript numbers bind as SQLite REAL,
  even whole ones: an INTEGER column stores `5` as `5`, but in an expression
  `? / 10` gives `0.5` and `'acct-' || ?` gives `'acct-5.0'`. Write
  `CAST(? AS INTEGER)` where a bound number must stay an integer.
- Outside a transaction, every statement commits on its own.
- `transaction(work)` runs `work` synchronously in one SQLite transaction and
  returns its value. Throwing rolls everything in it back. It cannot be nested.
- Queries receive read-only SQL: each runs in a transaction that is always
  rolled back, and one that changes rows fails. Mutations, webhook handlers and
  scheduled tools can write.
- Without migrations the app has no database, and every statement fails with an
  error saying so.

A transaction cannot `await`, so no transaction stays open while the app waits
on anything else. Calls to the same app run concurrently, so a slow `fetch` in
one call never holds up the app's other calls, including a provider's
verification callback into a webhook.

### Writes around outside calls

Nothing rolls back a `fetch` or a provider write. Order the work so a failure
leaves a state you can recover from:

```ts
const send = mutation({ input }, async (ctx, input) => {
  const id = crypto.randomUUID();
  // 1. Reserve: commits on its own, so the outgoing message can carry the ID.
  ctx.sql.exec(
    "INSERT INTO requests (id, status, created_at) VALUES (?, 'sending', ?)",
    id,
    Date.now(),
  );
  try {
    // 2. The outside call, with no transaction open.
    const messageId = await post(ctx, id, input);
    // 3. Publish.
    ctx.sql.exec("UPDATE requests SET status = 'sent', message_id = ? WHERE id = ?", messageId, id);
  } catch (error) {
    ctx.sql.exec("UPDATE requests SET status = 'failed' WHERE id = ?", id);
    throw error;
  }
  return { id };
});
```

A crash between steps 2 and 3 leaves a `sending` row; a scheduled cleanup can
mark old ones `failed`.

### Concurrent writes

Two calls can change the same row at once. Make the change conditional and check
that it happened:

```ts
const won =
  ctx.sql.exec("UPDATE requests SET status = 'cancelled' WHERE id = ? AND status = 'pending'", id)
    .rowsWritten > 0;
```

Compare `rowsWritten` with `0`, not `1`. As in Cloudflare's billing count, it
includes every index row the statement wrote, so updating an indexed column of
one row reports `2`.

Read-then-write logic belongs in one `transaction`, which no other call can
interleave with.

## Migrations

Migrations are SQL files directly in `migrations/`, named with a number that
orders them and a name: `0001_messages.sql`, `0002_add_status.sql`. A file can
hold several statements. Write them by hand; there is no generator.

When you deploy, the host applies the migrations the database has not seen, in
number order, all in one transaction. If one fails, the deploy fails with
SQLite's error and the file name, nothing is applied, and the previous
deployment stays active. Rolling back to an older deployment does not undo
migrations.

Applied migrations cannot change. The host records each one's name and a hash
of its contents; a deploy whose `migrations/` renames, edits or removes an
applied file fails and says which. To change the schema, add a new migration.

Comments can go anywhere in a migration, including after its last statement.

## Executor's tables

Tables named `_executor_*` belong to Executor: applied migrations, workflow step
receipts, and `_executor_legacy_rows (table_name, id, body)`, the rows an app
stored with the document API before `apps@0.0.1-beta.38` (JSON bodies). Read
them, but do not change them: changing the migration records fails the next
deploy, and deleting a step receipt lets that workflow step run again. See
[upgrades/0.0.1-beta.38.md](upgrades/0.0.1-beta.38.md) to copy old rows into
your own tables.

## Limits

App SQL is Cloudflare's Durable Object SQLite on every host, local included,
with its limits:

- A statement binds at most 100 values. Bind a long list as one JSON array and
  read it with `json_each`:

  ```ts
  ctx.sql
    .exec<Message>(
      "SELECT id, subject FROM messages WHERE id IN (SELECT value FROM json_each(?))",
      JSON.stringify(ids),
    )
    .toArray();
  ```

- A statement is at most 100 KB; a string, BLOB or row at most 2 MB; a table
  has at most 100 columns.
- A compound `SELECT` has at most 5 terms (`UNION`, `UNION ALL`, `INTERSECT`,
  `EXCEPT`), and a `LIKE` or `GLOB` pattern is at most 50 bytes.

There is no row budget. Every other call to the app waits while one statement
runs, so add an index or a `LIMIT` to keep statements short, and split large
work into batches: a workflow loop calling a mutation that handles one batch per
step (see [workflows.md](workflows.md)). Inside `transaction`, any statement that
fails rolls the whole transaction back, even if you catch its error.

A call has no deadline of its own; the caller's deadline bounds it:

- An MCP `execute` program has 5 minutes, shared by every call it makes. Time
  waiting for an approval or an answer does not count. Local's
  `EXECUTOR_MCP_TIMEOUT_MS` changes it.
- A workflow step has its `timeout`, 10 minutes by default.
- A webhook handler has 45 seconds, and an account check 15 seconds.

The app cache has its own limits; see "Cache and lazy operation sources" in
[tools.md](tools.md).
