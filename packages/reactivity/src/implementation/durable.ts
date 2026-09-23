import { Clock, Context, Effect, Schema, Semaphore } from "effect";
import type { SqlClient } from "effect/unstable/sql/SqlClient";
import {
  CoordinatorError,
  type DurableCoordinator,
  type DurableHost,
  type HibernatingSocket,
  type LiveQueryResolver,
} from "../contracts/durable.ts";
import { SubscriptionDescriptor } from "../contracts/store.ts";

const Attachment = Schema.Struct({
  descriptor: SubscriptionDescriptor,
  revision: Schema.Number,
  tables: Schema.Array(Schema.String),
});
const Revision = Schema.Struct({ revision: Schema.Number });
const TableVersion = Schema.Struct({ table_key: Schema.String, revision: Schema.Number });
const PendingWrites = Context.Reference<ReadonlyMap<symbol, Set<string>>>(
  "executor/reactivity/DurableWrites",
  {
    defaultValue: () => new Map(),
  },
);

/**
 * Persist revision metadata beside data in a Durable Object's SQLite database.
 * Supply the Effect DO SQL driver with its full `storage`, not only `storage.sql`.
 * No Effect stream or authorization decision is retained across hibernation.
 */
export const makeDurableCoordinator = (options: {
  readonly namespace: string;
  readonly sql: SqlClient;
  readonly host: DurableHost;
  readonly resolve: LiveQueryResolver;
}): Effect.Effect<DurableCoordinator, CoordinatorError> =>
  Effect.gen(function* () {
    const { sql, host } = options;
    const gate = yield* Semaphore.make(1);
    const identity = Symbol(options.namespace);
    yield* sql
      .withTransaction(
        Effect.gen(function* () {
          yield* sql`CREATE TABLE IF NOT EXISTS executor_live_revision (singleton INTEGER PRIMARY KEY CHECK (singleton = 1), revision INTEGER NOT NULL)`;
          yield* sql`INSERT OR IGNORE INTO executor_live_revision (singleton, revision) VALUES (1, 0)`;
          yield* sql`CREATE TABLE IF NOT EXISTS executor_live_tables (table_key TEXT PRIMARY KEY, revision INTEGER NOT NULL)`;
        }),
      )
      .pipe(Effect.mapError(() => new CoordinatorError({ operation: "initialize" })));

    const arm = Effect.gen(function* () {
      const now = yield* Clock.currentTimeMillis;
      yield* Effect.tryPromise({
        try: () => host.setAlarm(now + 1_000),
        catch: () => new CoordinatorError({ operation: "alarm" }),
      });
    });
    const socketEffect = (run: () => void) =>
      Effect.try({ try: run, catch: () => new CoordinatorError({ operation: "socket" }) });
    const close = (socket: HibernatingSocket, code: number, reason: string) =>
      socketEffect(() => socket.close(code, reason)).pipe(Effect.catch(() => Effect.void));
    const readRevision = sql`SELECT revision FROM executor_live_revision WHERE singleton = 1`.pipe(
      Effect.flatMap((rows) => Schema.decodeUnknownEffect(Revision)(rows[0])),
      Effect.map((row) => row.revision),
      Effect.mapError(() => new CoordinatorError({ operation: "read" })),
    );

    const drainLocked = Effect.gen(function* () {
      // This retry remains durable until every connected socket has caught up.
      yield* arm;
      const revision = yield* readRevision;
      const rows = yield* sql`SELECT table_key, revision FROM executor_live_tables`.pipe(
        Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(TableVersion))),
        Effect.mapError(() => new CoordinatorError({ operation: "read" })),
      );
      const tableVersions = new Map(rows.map((row) => [row.table_key, row.revision]));
      const sockets = yield* Effect.try({
        try: () => host.getWebSockets(),
        catch: () => new CoordinatorError({ operation: "socket" }),
      });
      let retry = false;
      for (const socket of sockets) {
        const delivered = yield* Effect.gen(function* () {
          const raw = yield* Effect.try({
            try: () => socket.deserializeAttachment(),
            catch: () => new CoordinatorError({ operation: "socket" }),
          });
          const attachment = yield* Schema.decodeUnknownEffect(Attachment)(raw).pipe(
            Effect.mapError(() => new CoordinatorError({ operation: "socket" })),
          );
          if (attachment.descriptor.namespace !== options.namespace) {
            yield* close(socket, 1008, "Invalid subscription");
            return;
          }
          if (attachment.revision === revision) return;
          const changed =
            attachment.revision < 0 ||
            attachment.tables.some(
              (table) => (tableVersions.get(table) ?? 0) > attachment.revision,
            );
          if (!changed) {
            yield* socketEffect(() => socket.serializeAttachment({ ...attachment, revision }));
            return;
          }
          const result = yield* options.resolve(attachment.descriptor).pipe(Effect.result);
          if (result._tag === "Failure") {
            yield* socketEffect(() =>
              socket.send(JSON.stringify({ type: "error", code: result.failure.code })),
            );
            yield* close(
              socket,
              result.failure.code === "unauthorized" ? 1008 : 1011,
              "Subscription ended",
            );
            return;
          }
          // Sending precedes cursor persistence. A crash may repeat a snapshot,
          // but cannot persist a delivered cursor before the platform got it.
          yield* socketEffect(() =>
            socket.send(
              JSON.stringify({ type: "snapshot", revision, value: result.success.value }),
            ),
          );
          yield* socketEffect(() =>
            socket.serializeAttachment({ ...attachment, revision, tables: result.success.tables }),
          );
        }).pipe(Effect.result);
        if (delivered._tag === "Failure") retry = true;
      }
      if (!retry)
        yield* Effect.tryPromise({
          try: () => host.deleteAlarm(),
          catch: () => new CoordinatorError({ operation: "alarm" }),
        });
    });

    const recover = gate.withPermits(1)(drainLocked);
    const subscribe: DurableCoordinator["subscribe"] = (socket, descriptor) =>
      gate.withPermits(1)(
        Effect.gen(function* () {
          if (descriptor.namespace !== options.namespace) {
            yield* close(socket, 1008, "Invalid subscription");
            return;
          }
          yield* arm;
          yield* socketEffect(() =>
            socket.serializeAttachment({ descriptor, revision: -1, tables: [] }),
          );
          yield* drainLocked;
        }),
      );

    const mutate: DurableCoordinator["mutate"] = (tables, effect) =>
      Effect.flatMap(PendingWrites, (parent) => {
        const enclosing = parent.get(identity);
        const collected = new Set(tables);
        const work = Effect.provideService(
          Effect.interruptible(effect),
          PendingWrites,
          new Map(parent).set(identity, collected),
        );
        if (enclosing !== undefined) {
          return Effect.uninterruptible(
            sql.withTransaction(work).pipe(
              Effect.tap(() =>
                Effect.sync(() => {
                  for (const table of collected) enclosing.add(table);
                }),
              ),
              Effect.catchTag("SqlError", () =>
                Effect.fail(new CoordinatorError({ operation: "commit" })),
              ),
            ),
          );
        }
        return gate.withPermits(1)(
          Effect.uninterruptible(
            Effect.gen(function* () {
              // Arm BEFORE commit. The gate prevents an interleaving alarm from clearing
              // recovery until this transaction has either committed or rolled back.
              yield* arm;
              const value = yield* sql
                .withTransaction(
                  Effect.gen(function* () {
                    const value = yield* work;
                    if (collected.size !== 0) {
                      yield* sql`UPDATE executor_live_revision SET revision = revision + 1 WHERE singleton = 1`;
                      const revision = yield* readRevision;
                      for (const table of collected) {
                        yield* sql`INSERT INTO executor_live_tables (table_key, revision) VALUES (${table}, ${revision}) ON CONFLICT(table_key) DO UPDATE SET revision = excluded.revision`;
                      }
                    }
                    return value;
                  }),
                )
                .pipe(
                  Effect.catchTag("SqlError", () =>
                    Effect.fail(new CoordinatorError({ operation: "commit" })),
                  ),
                );
              // Delivery failure cannot turn a committed mutation into a failed command:
              // the durable alarm retries it. Never encourage callers to repeat the write.
              yield* drainLocked.pipe(Effect.catch(() => Effect.void));
              return value;
            }),
          ),
        );
      });

    return { subscribe, mutate, recover };
  });
