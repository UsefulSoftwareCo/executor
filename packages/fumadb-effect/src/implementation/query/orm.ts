/**
 * The adapter-facing side of the query interface.
 *
 * `toOrm` turns an {@link OrmAdapter}, which works on resolved tables and
 * compiled conditions, into the typed {@link Orm} surface. It resolves table
 * names, folds constant conditions, and compiles joins.
 */
import { Effect } from "effect";
import { QueryError } from "../../contracts/errors.ts";
import type { AnyColumn } from "../../contracts/schema/column.ts";
import type { AnySchema } from "../../contracts/schema/schema.ts";
import type { AnyTable } from "../../contracts/schema/table.ts";
import { buildCondition, type Condition, type ConditionResult } from "../../contracts/condition.ts";
import type {
  AnySelectClause,
  ComputedSelect,
  FindFirstOptions,
  FindManyOptions,
  JoinBuilder,
  OrderBy,
  Orm,
  OrmError,
  UpsertOptions,
} from "../../contracts/query.ts";

import type {
  CompiledFindOptions,
  CompiledJoin,
  OrmAdapter,
  Row,
} from "../../contracts/query-adapter.ts";

const isOrderByArray = (v: OrderBy | ReadonlyArray<OrderBy>): v is ReadonlyArray<OrderBy> =>
  Array.isArray(v) && Array.isArray(v[0]);

const compileOrderBy = (
  table: AnyTable,
  orderBy: OrderBy | ReadonlyArray<OrderBy> | undefined,
): ReadonlyArray<OrderBy<AnyColumn>> | undefined => {
  if (orderBy === undefined || orderBy.length === 0) return undefined;
  const list = isOrderByArray(orderBy) ? orderBy : [orderBy];
  return list.map(([name, direction]) => {
    const col = table.columns[name];
    if (col === undefined) {
      throw new QueryError({
        reason: "UnknownColumn",
        message: `unknown column name ${name}.`,
        table: table.ormName,
        column: name,
      });
    }
    return [col, direction] as const;
  });
};

/** Evaluate a `where` callback, folding `true` to "no condition". Returns `false` when nothing can match. */
const compileWhere = (
  table: AnyTable,
  where: FindManyOptions["where"],
): Condition | undefined | false => {
  if (where === undefined) return undefined;
  const result: ConditionResult = buildCondition(table.columns, where);
  if (result === true) return undefined;
  return result;
};

const compileFindOptions = (
  table: AnyTable,
  options: FindManyOptions<
    AnyTable,
    AnySelectClause,
    {},
    true,
    ReadonlyArray<ComputedSelect<AnyTable>> | undefined
  >,
  isRoot = true,
): CompiledFindOptions | false => {
  const where = compileWhere(table, options.where);
  if (where === false) return false;
  if (!isRoot && options.computed !== undefined) {
    throw new QueryError({
      reason: "InvalidInput",
      message: "computed projections require a root query.",
      table: table.ormName,
    });
  }
  const aliases = new Set<string>();
  const computed = (options.computed ?? []).map((item) => {
    if (item.alias.length === 0 || item.alias.includes(":") || aliases.has(item.alias)) {
      throw new QueryError({
        reason: "InvalidInput",
        message: "computed aliases must be distinct, nonempty names without ':'.",
        table: table.ormName,
      });
    }
    if (table.columns[item.alias] !== undefined) {
      throw new QueryError({
        reason: "InvalidInput",
        message: `computed alias collides with column ${item.alias}.`,
        table: table.ormName,
        column: item.alias,
      });
    }
    if (table.relations[item.alias] !== undefined) {
      throw new QueryError({
        reason: "InvalidInput",
        message: `computed alias collides with relation ${item.alias}.`,
        table: table.ormName,
      });
    }
    const column = table.columns[item.column];
    if (column === undefined) {
      throw new QueryError({
        reason: "UnknownColumn",
        message: `unknown column name ${String(item.column)}.`,
        table: table.ormName,
        column: String(item.column),
      });
    }
    if (column.type !== "json") {
      throw new QueryError({
        reason: "InvalidInput",
        message: `jsonArrayLength requires a JSON column.`,
        table: table.ormName,
        column: String(item.column),
      });
    }
    aliases.add(item.alias);
    return { ...item, column };
  });
  return {
    select: options.select ?? true,
    computed,
    where,
    orderBy: compileOrderBy(table, options.orderBy),
    join: options.join === undefined ? undefined : compileJoin(table, options.join),
    limit: options.limit,
    offset: options.offset,
  };
};

const compileJoin = (
  table: AnyTable,
  fn: (builder: JoinBuilder<AnyTable, {}>) => JoinBuilder<AnyTable, unknown>,
): ReadonlyArray<CompiledJoin> => {
  const compiled: Array<CompiledJoin> = [];
  const builder: Record<string, unknown> = {};
  const joined = new Set<string>();
  for (const name of Object.keys(table.relations)) {
    const relation = table.relations[name];
    if (relation === undefined) continue;
    builder[name] = (options: FindFirstOptions | FindManyOptions = {}) => {
      if (joined.has(name)) {
        throw new QueryError({
          reason: "InvalidInput",
          message: `relation "${name}" is joined twice.`,
          table: table.ormName,
        });
      }
      joined.add(name);
      compiled.push({
        relation,
        options: compileFindOptions(relation.table, options as FindManyOptions, false),
      });
      return builder;
    };
  }
  fn(builder as JoinBuilder<AnyTable, {}>);
  return compiled;
};

/**
 * Run a synchronous compile step, turning a thrown `QueryError` into a typed failure.
 * Any other throw is a defect.
 */
const compile = <A>(thunk: () => A): Effect.Effect<A, QueryError> =>
  Effect.try({
    try: thunk,
    catch: (cause) => {
      if (cause instanceof QueryError) return cause;
      throw cause;
    },
  });

/** Build the typed query interface over an adapter. */
export const toOrm = <S extends AnySchema, R>(schema: S, adapter: OrmAdapter<R>): Orm<S, R> => {
  const resolveTable = (name: unknown): Effect.Effect<AnyTable, QueryError> => {
    const found = adapter.tables[String(name)];
    return found === undefined
      ? Effect.fail(
          new QueryError({
            reason: "UnknownTable",
            message: `Invalid table name ${String(name)}.`,
            table: String(name),
          }),
        )
      : Effect.succeed(found);
  };

  const withWhere = <A>(
    name: unknown,
    where: FindManyOptions["where"],
    onNever: A,
    run: (table: AnyTable, where: Condition | undefined) => Effect.Effect<A, OrmError, R>,
  ): Effect.Effect<A, OrmError, R> =>
    Effect.gen(function* () {
      const table = yield* resolveTable(name);
      const condition = yield* compile(() => compileWhere(table, where));
      if (condition === false) return onNever;
      return yield* run(table, condition);
    });

  const upsert = (
    name: unknown,
    options: UpsertOptions<AnyTable, boolean>,
  ): Effect.Effect<Row | void, OrmError, R> =>
    Effect.gen(function* () {
      const table = yield* resolveTable(name);
      const where = yield* compile(() => compileWhere(table, options.where));
      const returning = options.returning === true;
      if (where === false) {
        if (returning) {
          return yield* new QueryError({
            reason: "NoMatchingRow",
            message:
              "cannot return the upserted row of `upsert()`, its `where` condition never matches any row.",
            table: table.ormName,
          });
        }
        return undefined;
      }
      const result = yield* adapter.upsert(table, {
        where,
        create: options.create as Row,
        update: options.update as Row,
        returning,
      });
      if (!returning) return undefined;
      if (result === undefined) {
        return yield* new QueryError({
          reason: "UnexpectedResult",
          message: "the database adapter didn't return the upserted row.",
          table: table.ormName,
        });
      }
      return result;
    });

  const orm: Orm<AnySchema, R> = {
    schema,
    transaction: adapter.transaction,
    count: (name, options = {}) =>
      withWhere(name, options.where, 0, (table, where) => adapter.count(table, { where })),
    findFirst: (name, options = {}) =>
      Effect.gen(function* () {
        const table = yield* resolveTable(name);
        const compiled = yield* compile(() =>
          compileFindOptions(table, options as FindManyOptions),
        );
        if (compiled === false) return null;
        return yield* adapter.findFirst(table, compiled);
      }) as never,
    findMany: (name, options = {}) =>
      Effect.gen(function* () {
        const table = yield* resolveTable(name);
        const compiled = yield* compile(() =>
          compileFindOptions(table, options as FindManyOptions),
        );
        if (compiled === false) return [];
        return yield* adapter.findMany(table, compiled);
      }) as never,
    upsert: upsert as never,
    updateMany: (name, options) =>
      withWhere(name, options.where, undefined, (table, where) =>
        adapter.updateMany(table, { where, set: options.set as Row }),
      ),
    createMany: (name, values) =>
      Effect.flatMap(resolveTable(name), (table) =>
        adapter.createMany(table, values as ReadonlyArray<Row>),
      ),
    create: (name, values) =>
      Effect.flatMap(resolveTable(name), (table) => adapter.create(table, values as Row)) as never,
    deleteMany: (name, options = {}) =>
      withWhere(name, options.where, undefined, (table, where) =>
        adapter.deleteMany(table, { where }),
      ),
  };
  return orm as unknown as Orm<S, R>;
};
