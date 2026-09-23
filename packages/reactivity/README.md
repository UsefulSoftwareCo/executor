# Reactive storage

One Effect coordinator connects committed database writes to live query results.
The ORM adapter supplies table keys; query authors do not maintain dependency lists.

```ts
const reactive = yield * makeReactiveStore({ namespace: "executor" });

// ORM adapters record a table even when the query returns no rows.
const messages = reactive.read(["messages"], orm.findMany("messages", {}));

// Subscribe before evaluating; each subscriber gets an immediate full snapshot.
const snapshots = reactive.subscribe(messages);

// The wrapper surrounds the complete SQL transaction, including its commit.
yield *
  reactive.transaction(
    sql.withTransaction(
      Effect.interruptible(reactive.write(["messages"], orm.create("messages", message))),
    ),
  );
```

Each evaluation captures a fresh dependency set. Joins must include all related
tables in the adapter's read keys, even if no rows match. A change to an unrelated
table does not run the query. A commit overlapping a read triggers another read;
registration precedes the first read so setup cannot miss a notification.
Nested transaction collectors merge only on success. Notification after commit
is uninterruptible. Put `Effect.interruptible` around the SQL transaction body so
cancellation rolls it back; keep the commit and notification boundary masked.
Do not put network calls or unbounded work inside that boundary.

Streams use Effect Reactivity and close their registrations and query fibers on
disconnect. Slow consumers receive current snapshots rather than an accumulating
history of intermediate results. Reconnecting starts a new subscription and reads
current data; this is not replay from a previous revision.

## Runtime boundary

- Local and one Docker server share one coordinator per database.
- A revision belongs to that coordinator's lifetime. It is not a durable database
  sequence and cannot resume a stream after process restart.
- Separate coordinator instances do not notify each other, including instances
  with the same namespace label. Multiple servers need a commit journal/outbox
  and reliable cross-process wake-ups before using this implementation.
- This layer does not turn several reads into a database snapshot transaction.
  Use the database's transaction isolation when the query requires that guarantee.
- All writes must use the instrumented storage boundary. Raw SQL, migrations, and
  external writers do not become reactive automatically.

`SubscriptionDescriptor` contains a query name, JSON arguments, namespace and an
opaque caller reference. It is the serialization boundary for restoring a query,
including on a Durable Object after hibernation. It contains no executable
closure, credential, or saved authorization decision. The host must resolve the
query name, parse its arguments, and recheck authorization for each evaluation.
The local stream implementation itself is not hibernation-safe storage.

## Cloudflare Durable Objects

`@executor-js/reactivity/cloudflare` exports `makeDurableCoordinator`. It accepts
an Effect SQL client and narrow alarm/WebSocket ports from the Durable Object.
Use the Effect Durable Object SQLite driver with `storage: ctx.storage` so it
can transact. One object owns one database and namespace.

```ts
const coordinator =
  yield *
  makeDurableCoordinator({
    namespace: databaseId,
    sql,
    host: {
      getWebSockets: () => ctx.getWebSockets(),
      setAlarm: (at) => ctx.storage.setAlarm(at),
      deleteAlarm: () => ctx.storage.deleteAlarm(),
    },
    resolve: (descriptor) => registry.evaluateAndAuthorize(descriptor),
  });

// Instrumented writes name their affected tables. Nesting collects them into
// the outer transaction and publishes just one durable revision.
yield * coordinator.mutate([], coordinator.mutate(["messages"], insertMessage));
```

The host authenticates a new connection, accepts the hibernating WebSocket, and
calls `subscribe(socket, descriptor)` with the server-selected caller. There is
one query per socket. `resolve` parses query arguments and rechecks caller access
on every evaluation, returning its JSON value and actual table dependencies.
`ReactiveStore.evaluate` captures those dependencies for instrumented reads.
Descriptors plus dependency keys must fit Cloudflare's socket attachment limit
(2 KiB); large query arguments require a durable subscription record instead.

The coordinator saves subscription descriptors, dependencies and last-delivered
revisions in socket attachments. Data writes and table revisions commit in the
same SQLite transaction. It arms a persistent alarm _before_ committing. A
shared gate prevents the alarm handler from clearing that recovery while a
commit is pending. Delivery errors leave the alarm armed and do not turn a
successful database write into a failed command.

Call `recover` after construction and in the object's alarm handler. Recovery
reads durable table revisions and sends full current snapshots. It does not
replay transient events. Cursor persistence follows sending, so a crash may
repeat a snapshot but cannot mark an unsent snapshot as delivered. Reconnecting
still gets a fresh initial snapshot. A failed authorization ends the subscription.

This is a runtime adapter, not a hosted Executor service. It does not distribute
external Postgres/D1 commits or replicate data between objects. The actual
workerd test checks commit/rollback, unrelated-table filtering, loss of in-memory
state with a hibernating socket, recovery after post-commit delivery failure, and
authorization revocation. A Cloudflare account deployment has not been tested.

Native Effects retain read tracking through their Context. A Promise/runtime
boundary must explicitly capture and provide the invocation's Context when host
storage operations reenter Effect; starting a fresh runtime loses that tracking.
