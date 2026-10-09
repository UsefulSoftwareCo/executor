/** The hosted auth database is Postgres; other SQL drivers do not belong in this Worker. */
import { AsyncLocalStorage } from "node:async_hooks";
import { HostedAppSessions, hostedAppSessions } from "@executor-js/hosted-server/app-ui";
import { RuntimeContext } from "alchemy";
import { makeExecutionMemo } from "alchemy/Runtime/ExecutionMemo";
import {
  Cause,
  Context,
  Duration,
  Effect,
  ErrorReporter,
  Exit,
  Fiber,
  Layer,
  Option,
  Schema,
  Scope,
  Tracer,
} from "effect";
import { SqlClient, SqlError } from "effect/sql";
import { RecordedMessage } from "@executor-js/utils/recorded-message";
import {
  CompiledQuery,
  DeleteQueryNode,
  InsertQueryNode,
  Kysely,
  PostgresAdapter,
  PostgresIntrospector,
  PostgresQueryCompiler,
  SelectQueryNode,
  TableNode,
  UpdateQueryNode,
  type DatabaseConnection,
  type Driver,
  type QueryId,
  type QueryResult,
  type RootOperationNode,
} from "kysely";
import { ConnectionReservations } from "./database.ts";
import {
  type CleanupDeadline,
  EventCleanup,
  eventCleanup,
  sqlCancellation,
} from "./event-cleanup.ts";
import { cloudInvocationDatabase, InvocationDatabase } from "./invocation-database.ts";

const DriverCode = Schema.Struct({
  code: Schema.String.check(Schema.isPattern(/^(?:[0-9A-Z]{5}|E[A-Z_]{2,40})$/u)),
});
/**
 * A Better Auth query the database or its connection failed. `code` is the server's SQLSTATE
 * or the SQL client's failure kind, never the server's message, which can quote row values.
 */
class AuthDatabaseFailed extends Schema.TaggedError<AuthDatabaseFailed>()("AuthDatabaseFailed", {
  code: Schema.String,
}) {
  override get message() {
    return `Better Auth query failed: ${this.code}`;
  }
  /** Fixed text and a closed code: telemetry records the message itself. */
  get [RecordedMessage]() {
    return this.message;
  }
}

/**
 * Better Auth's database rate limiter inserts an address's row on its first request to a path.
 * When two such requests race, the later insert violates the key's unique index; Better Auth
 * catches that, reads the row the other request inserted and counts this request against it.
 * The request goes on, so the failed insert is recorded on its span but is not a fault to report.
 */
class AuthRateLimitRaced extends Schema.TaggedError<AuthRateLimitRaced>()(
  "AuthRateLimitRaced",
  {},
) {
  override get message() {
    return "Another request inserted this address's rate-limit row first; Better Auth counts against that row";
  }
  get [RecordedMessage]() {
    return this.message;
  }
  get [ErrorReporter.ignore]() {
    return true;
  }
}

/** A Better Auth query cancelled, or refused, because its invocation was closing its SQL client. */
class AuthQueryInterrupted extends Schema.TaggedError<AuthQueryInterrupted>()(
  "AuthQueryInterrupted",
  {},
) {
  override get message() {
    return "The invocation closed its SQL client before a Better Auth query finished";
  }
  get [RecordedMessage]() {
    return this.message;
  }
}

/** Better Auth work still running when its invocation's wait for it ran out. */
class AuthWorkUnsettled extends Schema.TaggedError<AuthWorkUnsettled>()("AuthWorkUnsettled", {
  queries: Schema.Number,
  connections: Schema.Number,
}) {
  override get message() {
    return `Better Auth work outlived its invocation: ${this.queries} queries running, ${this.connections} connections reserved`;
  }
  /** Fixed text and two counts: telemetry records the message itself. */
  get [RecordedMessage]() {
    return this.message;
  }
}

const failureCode = (error: unknown) =>
  Option.match(Schema.decodeUnknownOption(DriverCode)(error), {
    onNone: () => (SqlError.isSqlError(error) ? error.reason.name : "UnknownDriverError"),
    onSome: ({ code }) => code,
  });

/** Postgres's `unique_violation`. */
const uniqueViolation = "23505";

/** Better Auth's table of per-address request counts. */
const rateLimitTable = "rateLimit";

/**
 * How a failed Better Auth query is recorded. Only Better Auth's rate limiter inserts into its
 * table, and it handles losing that insert's race itself.
 */
const queryFailure = (error: unknown, node: RootOperationNode, table: string | undefined) => {
  if (error instanceof AuthQueryInterrupted) return { failure: error, code: undefined };
  const code = failureCode(error);
  return {
    failure:
      code === uniqueViolation && InsertQueryNode.is(node) && table === rateLimitTable
        ? new AuthRateLimitRaced()
        : new AuthDatabaseFailed({ code }),
    code,
  };
};

/**
 * How long a closing invocation waits for the Better Auth work it started. Queries take
 * milliseconds; this covers two connection attempts.
 */
const settleTimeout = Duration.seconds(10);

/**
 * How long a closing invocation lets a rollback of a transaction Better Auth left open run. It
 * starts only when the deadline also leaves time to cancel it.
 */
const resetTimeout = Duration.seconds(2);

/**
 * The Better Auth work one invocation started: bound calls and background tasks, the fibers
 * running its driver work, and the connections they reserved. Its client closes after all of it.
 */
class InvocationWork {
  readonly pending = new Set<Promise<unknown>>();
  readonly queries = new Set<Fiber.Fiber<unknown, unknown>>();
  readonly checkouts = new Set<ReservedConnection>();
  /** Set when the invocation closes; driver work started afterwards would outlive its client. */
  closed = false;
  /** Set when the wait ran out; the invocation then releases every connection itself. */
  abandoned = false;

  track<A>(work: Promise<A>) {
    this.pending.add(work);
    const done = () => this.pending.delete(work);
    work.then(done, done);
    return work;
  }

  /**
   * Wait for every tracked promise, then for one macrotask so continuations that issue another
   * query register it, until nothing is left.
   */
  async settled() {
    while (this.pending.size > 0) {
      await Promise.allSettled(this.pending);
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  }
}

/**
 * The invocation whose Promise work is calling Better Auth: the SQL client it shares with the
 * executor, where that client takes back reserved connections, the Better Auth work it must let
 * finish, and the context and span its SQL reports to.
 */
interface AuthInvocation {
  readonly sql: SqlClient.SqlClient;
  readonly reservations: ConnectionReservations["Service"];
  readonly work: InvocationWork;
  readonly context: Context.Context<never>;
  readonly parent: Option.Option<Tracer.AnySpan>;
}

/**
 * Better Auth and its Kysely instance live for the isolate, but workerd sockets
 * belong to one invocation. Every call into Better Auth runs inside
 * {@link AuthDatabaseService.bind}, and each connection comes from that caller's client.
 */
const invocation = new AsyncLocalStorage<AuthInvocation>();

const current = () => {
  const store = invocation.getStore();
  // A query outside a bound call has no invocation that may own its socket.
  if (store === undefined) throw new Error("Auth database used outside a bound invocation");
  return store;
};

/** The invocation's context, with the span that issued the call as parent when one was bound. */
const callerContext = ({ context, parent }: AuthInvocation) =>
  Option.match(parent, {
    onNone: () => context,
    onSome: (span) => Context.add(context, Tracer.ParentSpan, span),
  });

/**
 * Run driver work for Kysely in the caller's context, tracked until it settles. Interruption
 * rejects with {@link AuthQueryInterrupted} rather than Effect's generic interruption error, and
 * so does work started after the invocation closed.
 */
const runDriver = <A, E>(owner: AuthInvocation, effect: Effect.Effect<A, E>): Promise<A> => {
  const { work } = owner;
  if (work.closed) return Promise.reject(new AuthQueryInterrupted());
  const fiber = Effect.runForkWith(callerContext(owner))(effect);
  work.queries.add(fiber);
  return work.track(
    new Promise<A>((resolve, reject) =>
      fiber.addObserver((exit) => {
        work.queries.delete(fiber);
        if (Exit.isSuccess(exit)) resolve(exit.value);
        else
          reject(
            Cause.hasInterruptsOnly(exit.cause)
              ? new AuthQueryInterrupted()
              : Cause.squash(exit.cause),
          );
      }),
    ),
  );
};

const RawResult = Schema.Struct({
  command: Schema.String,
  rowCount: Schema.Number,
  rows: Schema.Array(Schema.Record(Schema.String, Schema.Unknown)),
  fields: Schema.Array(Schema.Struct({ name: Schema.String, dataTypeId: Schema.Number })),
});

/** PostgreSQL `int8` and `int8[]`, which node-postgres returns as strings. */
const int8Types = new Set([20, 1016]);

const int8Text = (value: unknown): unknown =>
  typeof value === "bigint" ? value.toString() : Array.isArray(value) ? value.map(int8Text) : value;

const quoted = (text: string) => `"${text.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;

/**
 * Better Auth was written against node-postgres, which sends every parameter as untyped text
 * and lets the server infer its type. The native client binds JavaScript numbers, booleans and
 * dates with concrete types, so convert them the way node-postgres does before binding.
 */
const textParameter = (value: unknown): unknown => {
  if (value === null || value === undefined) return null;
  if (value instanceof Uint8Array) return value;
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return arrayLiteral(value);
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
};

const arrayLiteral = (values: ReadonlyArray<unknown>): string =>
  `{${values
    .map((value) => {
      if (value === null || value === undefined) return "NULL";
      if (Array.isArray(value)) return arrayLiteral(value);
      if (value instanceof Uint8Array) return quoted(`\\x${Buffer.from(value).toString("hex")}`);
      return quoted(String(textParameter(value)));
    })
    .join(",")}}`;

/** One Kysely checkout: a connection reserved from the invocation's client until released. */
class ReservedConnection implements DatabaseConnection {
  /**
   * Possibly inside a transaction Better Auth began: from `begin` until a `commit` or
   * `rollback` succeeds.
   */
  transaction = false;
  /** Settles when the connection goes back to the pool or is given up. */
  readonly released: Promise<void>;
  private settle: () => void = () => {};

  constructor(
    private readonly connection: Effect.Success<SqlClient.SqlClient["reserve"]>,
    private readonly owner: AuthInvocation,
    private readonly scope: Scope.Closeable,
  ) {
    this.released = new Promise((resolve) => {
      this.settle = resolve;
    });
  }

  executeQuery<R>(query: CompiledQuery): Promise<QueryResult<R>> {
    return runDriver(
      this.owner,
      Effect.suspend(() =>
        this.connection.executeRaw(query.sql, query.parameters.map(textParameter)),
      ).pipe(
        // Each query already records `auth.sql.timing`; the native wire span would repeat it.
        Effect.withTracerEnabled(false),
        // Reject with the server's error fields (`code`, `constraint`), as node-postgres does.
        // Other failures, such as a lost connection, keep the SQL client's failure kind.
        Effect.mapError((error) =>
          error.reason.cause instanceof Error &&
          Option.isSome(Schema.decodeUnknownOption(DriverCode)(error.reason.cause))
            ? error.reason.cause
            : error,
        ),
        Effect.flatMap(Schema.decodeUnknownEffect(RawResult)),
        Effect.map(({ command, rowCount, rows, fields }) => {
          const int8 = fields.filter(({ dataTypeId }) => int8Types.has(dataTypeId));
          return {
            rows: (int8.length === 0
              ? rows
              : rows.map((row) => {
                  const converted = { ...row };
                  for (const { name } of int8) converted[name] = int8Text(row[name]);
                  return converted;
                })) as Array<R>,
            ...(["INSERT", "UPDATE", "DELETE", "MERGE"].includes(command)
              ? { numAffectedRows: BigInt(rowCount) }
              : {}),
          };
        }),
      ),
    );
  }

  async *streamQuery<R>(query: CompiledQuery): AsyncIterableIterator<QueryResult<R>> {
    yield await this.executeQuery<R>(query);
  }

  /** Return the connection to the pool. */
  private readonly close: Effect.Effect<void> = Effect.suspend(() => {
    this.owner.work.checkouts.delete(this);
    return Scope.close(this.scope, Exit.void);
  }).pipe(Effect.ensuring(Effect.sync(() => this.settle())));

  /**
   * Give the connection up: it stays reserved until its client's pool has shut down, which
   * closes it, and the server rolls back the transaction it may be in.
   */
  private readonly discard: Effect.Effect<void> = Effect.suspend(() => {
    this.owner.work.checkouts.delete(this);
    return this.owner.reservations.retire;
  }).pipe(Effect.ensuring(Effect.sync(() => this.settle())));

  /**
   * Kysely is done with the connection. Only a connection outside a transaction goes back to the
   * pool. Once the invocation abandoned its work, it finishes the connection itself.
   */
  release(): Promise<void> {
    if (this.owner.work.abandoned) return Promise.resolve();
    return Effect.runPromise(this.transaction ? this.discard : this.close);
  }

  /**
   * End the reservation of a connection no statement runs on any more. One inside a transaction
   * Better Auth left open goes back to the pool only after a rollback, started only when the
   * deadline leaves time both to run it and to cancel it. Otherwise, or when the rollback does
   * not succeed, the connection is given up rather than lent to another borrower.
   */
  finish(deadline: CleanupDeadline): Effect.Effect<void> {
    if (!this.transaction) return this.close;
    return deadline
      .within(Effect.exit(this.connection.executeRaw("rollback", [])), {
        max: resetTimeout,
        reserve: sqlCancellation,
        need: resetTimeout,
      })
      .pipe(
        Effect.flatMap((rolledBack) =>
          Option.exists(rolledBack, Exit.isSuccess) ? this.close : this.discard,
        ),
      );
  }
}

/**
 * Run `begin`, `commit` or `rollback`. The connection may be inside a transaction from the moment
 * `begin` is sent until a `commit` or `rollback` succeeds.
 */
const transactionControl = (connection: DatabaseConnection, sql: string, opens: boolean) => {
  if (opens && connection instanceof ReservedConnection) connection.transaction = true;
  return connection.executeQuery(CompiledQuery.raw(sql)).then(() => {
    if (!opens && connection instanceof ReservedConnection) connection.transaction = false;
  });
};

/**
 * Kysely's driver over the invocation's shared client. Each checkout reserves one connection
 * for itself, including a whole transaction, so Better Auth never joins or commits an executor
 * transaction. Releasing returns the connection to the client's pool.
 */
const invocationDriver: Driver = {
  init: () => Promise.resolve(),
  acquireConnection: () => {
    const owner = current();
    return runDriver(
      owner,
      Effect.gen(function* () {
        // A reservation the invocation does not end itself stays open until the pool has shut
        // down, so the pool closes it rather than lending it again.
        const scope = yield* Scope.fork(owner.reservations.scope, "sequential");
        const connection = yield* owner.sql.reserve.pipe(
          Scope.provide(scope),
          Effect.onError(() => Scope.close(scope, Exit.void)),
        );
        // Registered before this fiber ends, so a closing invocation sees every checkout once
        // it has stopped the fibers that acquire them.
        const checkout = new ReservedConnection(connection, owner, scope);
        owner.work.checkouts.add(checkout);
        owner.work.track(checkout.released);
        return checkout;
      }),
    );
  },
  beginTransaction: (connection, settings) =>
    transactionControl(
      connection,
      [
        "begin",
        settings.isolationLevel === undefined ? "" : `isolation level ${settings.isolationLevel}`,
        settings.accessMode ?? "",
      ].join(" "),
      true,
    ),
  commitTransaction: (connection) => transactionControl(connection, "commit", false),
  rollbackTransaction: (connection) => transactionControl(connection, "rollback", false),
  releaseConnection: (connection) =>
    connection instanceof ReservedConnection ? connection.release() : Promise.resolve(),
  // Each invocation's client closes with its event scope.
  destroy: () => Promise.resolve(),
};

/**
 * Close an invocation's Better Auth work before its client closes. Normally all of it has
 * finished, or finishes within milliseconds. Work still running when the wait runs out is
 * reported and cancelled, and each connection it reserved goes back to the pool only once no
 * statement is on it and it is outside any transaction Better Auth opened.
 */
const closeWork = (work: InvocationWork, deadline: CleanupDeadline) =>
  Effect.gen(function* () {
    const settled = yield* deadline.within(
      Effect.promise(() => work.settled()),
      { max: settleTimeout, reserve: sqlCancellation },
    );
    work.closed = true;
    if (Option.isSome(settled)) return;
    work.abandoned = true;
    const queries = [...work.queries];
    yield* Effect.fail(
      new AuthWorkUnsettled({ queries: queries.length, connections: work.checkouts.size }),
    ).pipe(Effect.withSpan("auth.invocation.unsettled"), Effect.withErrorReporting, Effect.ignore);
    // The SQL client cancels each running statement and drains its connection, or closes it.
    yield* Fiber.interruptAll(queries);
    yield* Effect.forEach([...work.checkouts], (checkout) => checkout.finish(deadline), {
      concurrency: "unbounded",
      discard: true,
    });
  });

/** The one table a query names directly, such as `apikey` for the key plugin's cleanup. */
const queryTable = (node: RootOperationNode) => {
  const tables = DeleteQueryNode.is(node)
    ? node.from.froms
    : UpdateQueryNode.is(node)
      ? [node.table]
      : InsertQueryNode.is(node)
        ? [node.into]
        : SelectQueryNode.is(node)
          ? (node.from?.froms ?? [])
          : [];
  const [table] = tables;
  return tables.length === 1 && table !== undefined && TableNode.is(table)
    ? table.table.identifier.name
    : undefined;
};

/**
 * Better Auth's Kysely instance. Each query records an `auth.sql.timing` span
 * under the span that issued it, or under its invocation when no span was bound.
 */
const timedAuthDatabase = () => {
  const started = new WeakMap<QueryId, number>();
  return new Kysely<unknown>({
    dialect: {
      createDriver: () => invocationDriver,
      createAdapter: () => new PostgresAdapter(),
      createIntrospector: (db) => new PostgresIntrospector(db),
      createQueryCompiler: () => new PostgresQueryCompiler(),
    },
    plugins: [
      {
        transformQuery: ({ queryId, node }) => {
          started.set(queryId, Date.now());
          return node;
        },
        transformResult: ({ result }) => Promise.resolve(result),
      },
    ],
    log: (event) => {
      const start = started.get(event.query.queryId);
      started.delete(event.query.queryId);
      const table = queryTable(event.query.query);
      const { failure, code } =
        event.level === "query"
          ? { failure: undefined, code: undefined }
          : queryFailure(event.error, event.query.query, table);
      return Effect.runPromiseWith(callerContext(current()))(
        (failure === undefined ? Effect.void : Effect.fail(failure)).pipe(
          Effect.withSpan("auth.sql.timing", {
            attributes: {
              "db.query.kind": event.query.query.kind,
              ...(table === undefined ? {} : { "db.collection.name": table }),
              "db.query.duration_ms": event.queryDurationMillis,
              "db.query.success": event.level === "query",
              ...(code === undefined ? {} : { "db.query.error_code": code }),
              "db.query.parameter_count": event.query.parameters.length,
              "db.query.clock": "cloudflare-io",
              ...(start === undefined
                ? {}
                : { "db.query.compile_to_result_ms": Date.now() - start }),
            },
          }),
          Effect.withErrorReporting,
          Effect.ignore,
        ),
      );
    },
  });
};

export interface AuthDatabaseService {
  /** Better Auth's `database` option. It holds no connection of its own. */
  readonly options: {
    readonly db: Kysely<unknown>;
    readonly type: "postgres";
    // SSO account resolution and membership provisioning require real
    // transactions; the Kysely adapter otherwise runs callbacks without one.
    readonly transaction: true;
  };
  /** Better Auth's background tasks join the invocation that started them. */
  readonly background: (task: Promise<unknown>) => void;
  /**
   * Bind Promise work to this invocation's client and the calling span, so its SQL
   * uses this event's socket and its timing spans become children of the caller.
   */
  readonly bind: Effect.Effect<<A>(run: () => A) => A, never, RuntimeContext>;
}

export class AuthDatabase extends Context.Service<AuthDatabase, AuthDatabaseService>()(
  "executor/cloud/AuthDatabase",
) {}

/**
 * App sessions whose Better Auth reads bind the calling operation's invocation when each
 * operation runs, not when the service is built. A layer builds in its own child of the event
 * scope, so binding there kept a second execution memo, and a second SQL client, beside the one
 * the executor uses in the same event; it also parented every auth query to the layer build.
 */
export const appSessionsPerCall = (
  adapters: Effect.Effect<Parameters<typeof hostedAppSessions>[0], never, RuntimeContext>,
): HostedAppSessions["Service"] => {
  const sessions = adapters.pipe(
    Effect.map((context) => hostedAppSessions(context, globalThis.crypto)),
    Effect.provide(RuntimeContext.phantom),
  );
  return HostedAppSessions.of({
    organization: (find) => Effect.flatMap(sessions, (live) => live.organization(find)),
    access: (principal, target) =>
      Effect.flatMap(sessions, (live) => live.access(principal, target)),
    begin: (target, returnTo) => Effect.flatMap(sessions, (live) => live.begin(target, returnTo)),
    pending: (request) => Effect.flatMap(sessions, (live) => live.pending(request)),
    grant: (request, target, principal) =>
      Effect.flatMap(sessions, (live) => live.grant(request, target, principal)),
    complete: (target, request, code, proof) =>
      Effect.flatMap(sessions, (live) => live.complete(target, request, code, proof)),
    current: (target, token) => Effect.flatMap(sessions, (live) => live.current(target, token)),
  });
};

/** An object whose methods run as work bound by {@link AuthDatabaseService.bind}. */
export const boundAuthAdapter = <A extends object>(adapter: A, bind: <B>(run: () => B) => B): A =>
  new Proxy(adapter, {
    get(target, key, receiver) {
      const value: unknown = Reflect.get(target, key, receiver);
      return typeof value === "function"
        ? (...args: ReadonlyArray<unknown>) => bind(() => Reflect.apply(value, target, args))
        : value;
    },
  });

/**
 * One Kysely instance per isolate. Each invocation's queries use the SQL client the executor
 * uses in the same Worker event or Durable Object call, so they reuse its connections.
 */
const authDatabase = Layer.effect(
  AuthDatabase,
  Effect.gen(function* () {
    const database = yield* InvocationDatabase;
    const cleanup = yield* EventCleanup;
    const resources = yield* makeExecutionMemo(
      Effect.gen(function* () {
        // Building a client opens no connection; a malformed URL is a deployment defect.
        const services = yield* Effect.orDie(database);
        const sql = Context.get(services, SqlClient.SqlClient);
        const reservations = Context.get(services, ConnectionReservations);
        const work = new InvocationWork();
        const deadline = yield* cleanup.deadline;
        // Added after the client, so it runs before the client closes. Better Auth leaves some
        // queries unawaited (the API key plugin's expired-key cleanup), and a call whose caller
        // was interrupted keeps running; both keep their socket until they settle.
        yield* Effect.addFinalizer(() => closeWork(work, deadline));
        return { sql, reservations, work };
      }),
    );
    return AuthDatabase.of({
      options: { db: timedAuthDatabase(), type: "postgres", transaction: true },
      background: (task) => void current().work.track(task),
      bind: Effect.gen(function* () {
        const { sql, reservations, work } = yield* resources;
        const parent = yield* Effect.option(Effect.currentParentSpan);
        // This trusted host callback needs the complete invocation context.
        const context = yield* Effect.context<never>();
        const owner: AuthInvocation = { sql, reservations, work, context, parent };
        return <A>(run: () => A) =>
          invocation.run(owner, () => {
            const result = run();
            if (result instanceof Promise) work.track(result);
            return result;
          });
      }),
    });
  }),
);

/**
 * Better Auth, the executor's shared client and the event's cleanup deadline: provide this once
 * where they are built, so every consumer shares one deadline per event.
 */
export const cloudAuthDatabase = authDatabase.pipe(
  Layer.provideMerge(Layer.mergeAll(cloudInvocationDatabase, eventCleanup)),
);
