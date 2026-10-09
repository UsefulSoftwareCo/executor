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
    .rowsWritten === 1;
```

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

## Executor's tables

Tables named `_executor_*` belong to Executor: applied migrations, workflow step
receipts, and `_executor_legacy_rows (table_name, id, body)`, the rows an app
stored with the document API before `apps@0.0.1-beta.38` (JSON bodies). Read
them, but do not change them: changing the migration records fails the next
deploy, and deleting a step receipt lets that workflow step run again. See
[upgrades/0.0.1-beta.38.md](upgrades/0.0.1-beta.38.md) to copy old rows into
your own tables.

## Limits

There is no row budget, but a call must finish within the host's call deadline,
and while one statement runs every other call to the app waits for the
database. Add an index or a `LIMIT` to keep statements short, and split large
work into batches: a workflow loop calling a mutation that handles one batch per
step (see [workflows.md](workflows.md)). Inside `transaction`, any statement that
fails rolls the whole transaction back, even if you catch its error.
