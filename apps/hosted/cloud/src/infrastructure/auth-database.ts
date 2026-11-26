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
class AuthDatabaseFailed extends Schema.TaggedError<AuthDatabaseFailed>()("AuthDatabaseFailed", {
  code: Schema.String,
}) {
  override get message() {
    return `Better Auth query failed: ${this.code}`;
  }
  get [RecordedMessage]() {
    return this.message;
  }
}

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

class AuthWorkUnsettled extends Schema.TaggedError<AuthWorkUnsettled>()("AuthWorkUnsettled", {
  queries: Schema.Number,
  connections: Schema.Number,
}) {
  override get message() {
    return `Better Auth work outlived its invocation: ${this.queries} queries running, ${this.connections} connections reserved`;
  }
  get [RecordedMessage]() {
    return this.message;
  }
}

const failureCode = (error: unknown) =>
  Option.match(Schema.decodeUnknownOption(DriverCode)(error), {
    onNone: () => (SqlError.isSqlError(error) ? error.reason.name : "UnknownDriverError"),
    onSome: ({ code }) => code,
  });

const uniqueViolation = "23505";

const rateLimitTable = "rateLimit";

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

const settleTimeout = Duration.seconds(10);

const resetTimeout = Duration.seconds(2);

class InvocationWork {
  readonly pending = new Set<Promise<unknown>>();
  readonly queries = new Set<Fiber.Fiber<unknown, unknown>>();
  readonly checkouts = new Set<ReservedConnection>();
  closed = false;
  abandoned = false;

  track<A>(work: Promise<A>) {
    this.pending.add(work);
    const done = () => this.pending.delete(work);
    work.then(done, done);
    return work;
  }

  async settled() {
    while (this.pending.size > 0) {
      await Promise.allSettled(this.pending);
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  }
}

interface AuthInvocation {
  readonly sql: SqlClient.SqlClient;
  readonly reservations: ConnectionReservations["Service"];
  readonly work: InvocationWork;
  readonly context: Context.Context<never>;
  readonly parent: Option.Option<Tracer.AnySpan>;
}

const invocation = new AsyncLocalStorage<AuthInvocation>();

const current = () => {
  const store = invocation.getStore();
  if (store === undefined) throw new Error("Auth database used outside a bound invocation");
  return store;
};

const callerContext = ({ context, parent }: AuthInvocation) =>
  Option.match(parent, {
    onNone: () => context,
    onSome: (span) => Context.add(context, Tracer.ParentSpan, span),
  });

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

const int8Types = new Set([20, 1016]);

const int8Text = (value: unknown): unknown =>
  typeof value === "bigint" ? value.toString() : Array.isArray(value) ? value.map(int8Text) : value;

const quoted = (text: string) => `"${text.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;

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

class ReservedConnection implements DatabaseConnection {
  transaction = false;
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
        Effect.withTracerEnabled(false),
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

  private readonly close: Effect.Effect<void> = Effect.suspend(() => {
    this.owner.work.checkouts.delete(this);
    return Scope.close(this.scope, Exit.void);
  }).pipe(Effect.ensuring(Effect.sync(() => this.settle())));

  private readonly discard: Effect.Effect<void> = Effect.suspend(() => {
    this.owner.work.checkouts.delete(this);
    return this.owner.reservations.retire;
  }).pipe(Effect.ensuring(Effect.sync(() => this.settle())));

  release(): Promise<void> {
    if (this.owner.work.abandoned) return Promise.resolve();
    return Effect.runPromise(this.transaction ? this.discard : this.close);
  }

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

const transactionControl = (connection: DatabaseConnection, sql: string, opens: boolean) => {
  if (opens && connection instanceof ReservedConnection) connection.transaction = true;
  return connection.executeQuery(CompiledQuery.raw(sql)).then(() => {
    if (!opens && connection instanceof ReservedConnection) connection.transaction = false;
  });
};

const invocationDriver: Driver = {
  init: () => Promise.resolve(),
  acquireConnection: () => {
    const owner = current();
    return runDriver(
      owner,
      Effect.gen(function* () {
        const scope = yield* Scope.fork(owner.reservations.scope, "sequential");
        const connection = yield* owner.sql.reserve.pipe(
          Scope.provide(scope),
          Effect.onError(() => Scope.close(scope, Exit.void)),
        );
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
  destroy: () => Promise.resolve(),
};

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
    yield* Fiber.interruptAll(queries);
    yield* Effect.forEach([...work.checkouts], (checkout) => checkout.finish(deadline), {
      concurrency: "unbounded",
      discard: true,
    });
  });

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
  readonly options: {
    readonly db: Kysely<unknown>;
    readonly type: "postgres";
    readonly transaction: true;
  };
  readonly background: (task: Promise<unknown>) => void;
  readonly bind: Effect.Effect<<A>(run: () => A) => A, never, RuntimeContext>;
}

export class AuthDatabase extends Context.Service<AuthDatabase, AuthDatabaseService>()(
  "executor/cloud/AuthDatabase",
) {}

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
    launch: (target, user, parent) =>
      Effect.flatMap(sessions, (live) => live.launch(target, user, parent)),
    redeem: (target, code) => Effect.flatMap(sessions, (live) => live.redeem(target, code)),
    complete: (target, request, code, proof) =>
      Effect.flatMap(sessions, (live) => live.complete(target, request, code, proof)),
    current: (target, token) => Effect.flatMap(sessions, (live) => live.current(target, token)),
  });
};

export const boundAuthAdapter = <A extends object>(adapter: A, bind: <B>(run: () => B) => B): A =>
  new Proxy(adapter, {
    get(target, key, receiver) {
      const value: unknown = Reflect.get(target, key, receiver);
      return typeof value === "function"
        ? (...args: ReadonlyArray<unknown>) => bind(() => Reflect.apply(value, target, args))
        : value;
    },
  });

const authDatabase = Layer.effect(
  AuthDatabase,
  Effect.gen(function* () {
    const database = yield* InvocationDatabase;
    const cleanup = yield* EventCleanup;
    const resources = yield* makeExecutionMemo(
      Effect.gen(function* () {
        const services = yield* Effect.orDie(database);
        const sql = Context.get(services, SqlClient.SqlClient);
        const reservations = Context.get(services, ConnectionReservations);
        const work = new InvocationWork();
        const deadline = yield* cleanup.deadline;
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

export const cloudAuthDatabase = authDatabase.pipe(
  Layer.provideMerge(Layer.mergeAll(cloudInvocationDatabase, eventCleanup)),
);
