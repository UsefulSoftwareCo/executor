/**
 * OrmAdapter over Effect SQL's `SqlClient`.
 *
 * - Every identifier goes through `sql(name)`; every value through parameters.
 * - Values are encoded with `serialize` and decoded with `deserialize` from `schema/codec.ts`.
 * - Row keys in results are ORM names; joined rows nest under the relation name.
 * - Defaults for omitted insert columns are generated with `column.generateDefault()`.
 *
 * Provider differences this module handles: `RETURNING` (PostgreSQL,
 * CockroachDB, SQLite), `OUTPUT INSERTED` (MSSQL), neither (MySQL, which reads
 * the row back by id), `SELECT TOP (n)` and `OFFSET ... FETCH NEXT` on MSSQL,
 * and `COUNT(*)` coming back as a bigint on PostgreSQL and CockroachDB.
 */
import { DateTime, Effect, Equal, Option, Result } from "effect";
import { Statement } from "effect/unstable/sql";
import { SqlClient } from "effect/unstable/sql/SqlClient";
import { QueryError } from "../../contracts/errors.ts";
import type { Provider } from "../../contracts/provider.ts";
import { Condition } from "../../contracts/condition.ts";
import type { AnySelectClause, OrderBy, OrmError } from "../../contracts/query.ts";
import type {
  CompiledFindOptions,
  CompiledJoin,
  CompiledUpsert,
  OrmAdapter,
  Row,
} from "../../contracts/query-adapter.ts";
import { deserialize, serialize } from "../schema-codec.ts";
import type { AnyColumn } from "../../contracts/schema/column.ts";
import type { AnyRelation } from "../../contracts/schema/relation.ts";
import type { AnySchema } from "../../contracts/schema/schema.ts";
import type { AnyTable } from "../../contracts/schema/table.ts";
import type { ResolvedSqlAdapterConfig } from "../../contracts/sql.ts";
import { buildWhere, defaultAlias } from "./where.ts";

/** One entry of a select list: the column reference and the key it is returned under. */
interface Selection {
  readonly source: string | Statement.Fragment;
  readonly alias: string;
}

const computedSelect = (
  sql: SqlClient,
  provider: Provider,
  item: CompiledFindOptions["computed"][number],
  table: AnyTable,
): Selection => {
  const reference = sql(`${table.names.sql}.${item.column.names.sql}`);
  let source: Statement.Fragment;
  switch (provider) {
    case "postgresql":
    case "cockroachdb":
      source = sql`CASE WHEN jsonb_typeof(CAST(${reference} AS jsonb)) = 'array' THEN jsonb_array_length(CAST(${reference} AS jsonb)) ELSE NULL END`;
      break;
    case "mysql":
      source = sql`CASE WHEN JSON_TYPE(${reference}) = 'ARRAY' THEN JSON_LENGTH(${reference}) ELSE NULL END`;
      break;
    case "sqlite":
      source = sql`CASE WHEN json_type(${reference}) = 'array' THEN json_array_length(${reference}) ELSE NULL END`;
      break;
    case "mssql":
      source = sql`CASE WHEN LEFT(LTRIM(${reference}), 1) = '[' THEN (SELECT COUNT(*) FROM OPENJSON(${reference})) ELSE NULL END`;
      break;
  }
  return { source, alias: item.alias };
};

/** Join fragments with a single space, without adding parentheses. */
const spaced = Statement.join(" ", false, "");

/** `NULL`, absent, or `Option.none()`: a join value that can never match a row. */
const isAbsentKey = (value: unknown): boolean =>
  value === null || value === undefined || (Option.isOption(value) && Option.isNone(value));

/** A JSON-safe, identity-preserving form of a join key value for deduplication. */
const keyPart = (value: unknown): unknown => {
  if (Option.isOption(value)) return Option.isSome(value) ? keyPart(value.value) : null;
  if (typeof value === "bigint") return `${value}n`;
  if (value instanceof Date) return `date:${value.getTime()}`;
  if (value instanceof Uint8Array) return `bytes:${Array.from(value).join(",")}`;
  if (DateTime.isDateTime(value)) return `dt:${DateTime.toEpochMillis(value)}`;
  return value;
};

/** Split a list into groups of at most `size`. */
const chunk = <A>(items: ReadonlyArray<A>, size: number): Array<ReadonlyArray<A>> => {
  const out: Array<ReadonlyArray<A>> = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
};

/**
 * The number of bound parameters one statement may carry, with headroom.
 * MSSQL allows 2100, SQLite 32766, PostgreSQL and CockroachDB 32767; MySQL
 * substitutes parameters client-side and has no comparable ceiling.
 */
const parameterBudget = (provider: Provider): number => {
  switch (provider) {
    case "mssql":
      return 2000;
    case "sqlite":
    case "postgresql":
    case "cockroachdb":
      return 32000;
    case "mysql":
      return 60000;
  }
};

/** A row as the driver returns it: keys are the aliases of the select list. */
type RawRow = Record<string, unknown>;

/**
 * A select clause that extra columns can be added to, so a sub-query join can
 * read the columns it joins on even when the caller did not select them. The
 * added keys are removed from the rows before they are returned.
 */
const extendSelect = (
  original: AnySelectClause,
): {
  readonly extend: (key: string) => void;
  readonly compile: () => {
    readonly result: AnySelectClause;
    readonly removeExtendedKeys: (row: Row) => void;
  };
} => {
  const select = Array.isArray(original) ? new Set(original.map(String)) : undefined;
  const extendedKeys: Array<string> = [];
  return {
    extend(key) {
      if (select === undefined || select.has(key)) return;
      select.add(key);
      extendedKeys.push(key);
    },
    compile: () => ({
      result: select === undefined ? true : Array.from(select),
      removeExtendedKeys(row) {
        for (const key of extendedKeys) delete row[key];
      },
    }),
  };
};

/**
 * The SQL adapter's implementation of the ORM operations.
 *
 * @param schema the resolved schema version (names already applied).
 * @param config the provider and relation mode of the target database.
 */
export const makeSqlOrmAdapter = (
  schema: AnySchema,
  config: ResolvedSqlAdapterConfig,
): OrmAdapter<SqlClient> => {
  const provider: Provider = config.provider;

  const columnOf = (table: AnyTable, ormName: string): Effect.Effect<AnyColumn, QueryError> => {
    const column = table.columns[ormName];
    return column === undefined
      ? Effect.fail(
          new QueryError({
            reason: "UnknownColumn",
            message: `unknown column name ${ormName}.`,
            table: table.ormName,
            column: ormName,
          }),
        )
      : Effect.succeed(column);
  };

  /** The select list for a table, aliased to ORM names (or `relation:ormName`). */
  const mapSelect = (
    select: AnySelectClause,
    table: AnyTable,
    options: { readonly relation?: string; readonly tableName?: string } = {},
  ): Effect.Effect<Array<Selection>, QueryError> =>
    Effect.forEach(Array.isArray(select) ? select.map(String) : Object.keys(table.columns), (key) =>
      Effect.map(columnOf(table, key), (column) => ({
        source:
          options.tableName === undefined
            ? column.names.sql
            : `${options.tableName}.${column.names.sql}`,
        alias: options.relation === undefined ? key : `${options.relation}:${key}`,
      })),
    );

  const selectList = (sql: SqlClient, selections: ReadonlyArray<Selection>): Statement.Fragment =>
    sql.csv(
      selections.map((item) =>
        typeof item.source === "string"
          ? sql`${sql(item.source)} AS ${sql(item.alias)}`
          : sql`${item.source} AS ${sql(item.alias)}`,
      ),
    );

  /** `INSERTED.<column> AS <ormName>` for an MSSQL `OUTPUT` clause. */
  const outputList = (sql: SqlClient, table: AnyTable): Statement.Fragment =>
    sql.csv(
      Object.entries(table.columns).flatMap(([ormName, column]) =>
        column === undefined
          ? []
          : [sql`${sql(`INSERTED.${column.names.sql}`)} AS ${sql(ormName)}`],
      ),
    );

  /** `<column> AS <ormName>` for a `RETURNING` clause (no table qualifier). */
  const returningList = (sql: SqlClient, table: AnyTable): Statement.Fragment =>
    sql.csv(
      Object.entries(table.columns).flatMap(([ormName, column]) =>
        column === undefined ? [] : [sql`${sql(column.names.sql)} AS ${sql(ormName)}`],
      ),
    );

  /**
   * ORM values -> SQL values. Missing columns take their runtime default when
   * `generateDefault` is set; columns without a value are left out entirely.
   */
  const prepareValues = (
    table: AnyTable,
    values: Row,
    generateDefault: boolean,
  ): Effect.Effect<
    { readonly values: Row; readonly encoded: Record<string, unknown> },
    QueryError
  > =>
    Effect.gen(function* () {
      const resolved: Row = {};
      const encoded: Record<string, unknown> = {};
      for (const [ormName, column] of Object.entries(table.columns)) {
        if (column === undefined) continue;
        let value = values[ormName];
        if (generateDefault && value === undefined) value = yield* column.generateDefault();
        if (value === undefined) continue;
        resolved[ormName] = value;
        encoded[column.names.sql] = yield* Effect.fromResult(serialize(value, column, provider));
      }
      return { values: resolved, encoded };
    });

  /** `WHERE <condition>`, or a typed failure when a value does not satisfy its column schema. */
  const whereClause = (
    sql: SqlClient,
    condition: Condition,
    aliasOf?: (table: AnyTable) => string,
  ): Effect.Effect<Statement.Fragment, QueryError> =>
    Effect.fromResult(
      Result.map(
        buildWhere(condition, sql, provider, aliasOf),
        (fragment) => sql`WHERE ${fragment}`,
      ),
    );

  /** Driver row -> ORM row: ORM keys, decoded values, joined columns nested under the relation name. */
  const decodeResult = (
    row: RawRow,
    table: AnyTable,
    computed: ReadonlyArray<{ readonly alias: string }> = [],
  ): Result.Result<Row, QueryError> => {
    const output: Row = {};
    const computedAliases = new Set(computed.map((item) => item.alias));
    const nested = new Map<string, Row>();
    for (const [key, value] of Object.entries(row)) {
      const separator = key.indexOf(":");
      if (separator === -1) {
        const column = table.columns[key];
        if (column === undefined) {
          if (computedAliases.has(key)) output[key] = value;
          continue;
        }
        const decoded = deserialize(value, column, provider);
        if (Result.isFailure(decoded)) return Result.fail(decoded.failure);
        output[key] = decoded.success;
        continue;
      }
      const relationName = key.slice(0, separator);
      const columnName = key.slice(separator + 1);
      const relation = table.relations[relationName];
      if (relation === undefined) continue;
      const column = relation.table.columns[columnName];
      if (column === undefined) continue;
      let target = nested.get(relationName);
      if (target === undefined) {
        target = {};
        nested.set(relationName, target);
      }
      const decoded = deserialize(value, column, provider);
      if (Result.isFailure(decoded)) return Result.fail(decoded.failure);
      target[columnName] = decoded.success;
    }
    for (const [key, value] of nested) output[key] = value;
    return Result.succeed(output);
  };

  /** Decode every row, failing on the first undecodable value. */
  const decodeRows = (
    rows: ReadonlyArray<RawRow>,
    table: AnyTable,
    computed: ReadonlyArray<{ readonly alias: string }> = [],
  ): Effect.Effect<Array<Row>, QueryError> =>
    Effect.fromResult(Result.all(rows.map((row) => decodeResult(row, table, computed))));

  const orderByFragment = (
    sql: SqlClient,
    orderBy: ReadonlyArray<OrderBy<AnyColumn>>,
  ): Statement.Fragment =>
    sql.csv(
      "ORDER BY",
      orderBy.map(
        ([column, direction]) =>
          sql`${sql(`${column.table.names.sql}.${column.names.sql}`)}${sql.literal(direction === "desc" ? " DESC" : " ASC")}`,
      ),
    );

  /** A row count used in `LIMIT`, `TOP`, `OFFSET`, or `FETCH NEXT`. */
  const rowCount = (value: number, name: string): Effect.Effect<string, QueryError> =>
    Number.isSafeInteger(value) && value >= 0
      ? Effect.succeed(String(value))
      : Effect.fail(
          new QueryError({
            reason: "InvalidInput",
            message: `${name} must be a non-negative integer.`,
          }),
        );

  /**
   * MySQL and SQLite reject `OFFSET` without a `LIMIT`, so an offset-only query
   * needs a limit that means "all rows". PostgreSQL and CockroachDB do not.
   */
  const emptyLimit =
    provider === "mysql" ? "18446744073709551615" : provider === "sqlite" ? "-1" : undefined;

  const findManyImpl: (
    table: AnyTable,
    options: CompiledFindOptions,
  ) => Effect.Effect<Array<Row>, OrmError, SqlClient> = Effect.fn("FumaDB.SqlQuery.findMany")(
    function* (table: AnyTable, options: CompiledFindOptions) {
      const sql = yield* SqlClient;
      const selectBuilder = extendSelect(options.select);
      const joinSelections: Array<Selection> = [];
      const joinClauses: Array<Statement.Fragment> = [];
      const subQueryJoins: Array<CompiledJoin> = [];
      const flatJoins: Array<{
        readonly name: string;
        readonly idKey: string;
        readonly cleanup: (record: Row) => void;
      }> = [];

      for (const join of options.join ?? []) {
        const joinOptions = join.options;
        const relation = join.relation;
        // A `many` relation, a join with joins of its own, and a join whose
        // condition can never match are all resolved after the main query.
        if (joinOptions === false || relation.type === "many" || joinOptions.join !== undefined) {
          subQueryJoins.push(join);
          if (joinOptions !== false) {
            for (const [left] of relation.on) selectBuilder.extend(left);
          }
          continue;
        }
        const target = relation.table;
        const alias = relation.name;
        // The target's id column decides whether the LEFT JOIN matched a row.
        const joinSelect = extendSelect(joinOptions.select);
        joinSelect.extend(target.getIdColumn().ormName);
        const compiledJoinSelect = joinSelect.compile();
        flatJoins.push({
          name: alias,
          idKey: target.getIdColumn().ormName,
          cleanup: (record) => compiledJoinSelect.removeExtendedKeys(record),
        });
        joinSelections.push(
          ...(yield* mapSelect(compiledJoinSelect.result, target, {
            relation: alias,
            tableName: alias,
          })),
        );
        const on: Array<Statement.Fragment> = [];
        for (const [left, right] of relation.on) {
          const leftColumn = yield* columnOf(table, left);
          const rightColumn = yield* columnOf(target, right);
          on.push(
            sql`${sql(`${table.names.sql}.${leftColumn.names.sql}`)} = ${sql(`${alias}.${rightColumn.names.sql}`)}`,
          );
        }
        if (joinOptions.where !== undefined) {
          on.push(
            yield* Effect.fromResult(
              buildWhere(joinOptions.where, sql, provider, (t) =>
                t === target ? alias : defaultAlias(t),
              ),
            ),
          );
        }
        joinClauses.push(
          sql`LEFT JOIN ${sql(target.names.sql)} AS ${sql(alias)} ON ${sql.and(on)}`,
        );
      }

      const compiledSelect = selectBuilder.compile();
      const selections = [
        ...joinSelections,
        ...(yield* mapSelect(compiledSelect.result, table, { tableName: table.names.sql })),
        ...options.computed.map((item) => computedSelect(sql, provider, item, table)),
      ];

      const useTop =
        provider === "mssql" && options.limit !== undefined && options.offset === undefined;
      const parts: Array<Statement.Fragment> = [
        useTop && options.limit !== undefined
          ? sql`SELECT TOP (${sql.literal(yield* rowCount(options.limit, "limit"))}) ${selectList(sql, selections)}`
          : sql`SELECT ${selectList(sql, selections)}`,
        sql`FROM ${sql(table.names.sql)}`,
        ...joinClauses,
      ];
      if (options.where !== undefined) parts.push(yield* whereClause(sql, options.where));

      const orderBy =
        options.orderBy ??
        (provider === "mssql" && options.offset !== undefined
          ? [[table.getIdColumn(), "asc"] as const]
          : undefined);
      if (orderBy !== undefined && orderBy.length > 0) parts.push(orderByFragment(sql, orderBy));

      if (!useTop) {
        if (provider === "mssql") {
          if (options.offset !== undefined) {
            parts.push(sql`OFFSET ${sql.literal(yield* rowCount(options.offset, "offset"))} ROWS`);
            if (options.limit !== undefined) {
              parts.push(
                sql`FETCH NEXT ${sql.literal(yield* rowCount(options.limit, "limit"))} ROWS ONLY`,
              );
            }
          }
        } else {
          if (options.limit !== undefined)
            parts.push(sql`LIMIT ${sql.literal(yield* rowCount(options.limit, "limit"))}`);
          else if (options.offset !== undefined && emptyLimit !== undefined)
            parts.push(sql`LIMIT ${sql.literal(emptyLimit)}`);
          if (options.offset !== undefined)
            parts.push(sql`OFFSET ${sql.literal(yield* rowCount(options.offset, "offset"))}`);
        }
      }

      const rows = yield* sql<RawRow>`${spaced(parts)}`;
      const records = yield* decodeRows(rows, table, options.computed);
      // A LEFT JOIN that matched nothing yields a row of NULLs; report it as no row.
      for (const record of records) {
        for (const join of flatJoins) {
          const joined = record[join.name];
          if (typeof joined !== "object" || joined === null) continue;
          const nested = joined as Row;
          if (nested[join.idKey] === null) record[join.name] = null;
          else join.cleanup(nested);
        }
      }
      yield* Effect.forEach(subQueryJoins, (join) => runSubQueryJoin(records, join));
      for (const record of records) compiledSelect.removeExtendedKeys(record);
      return records;
    },
  );

  /**
   * Attach a relation that cannot be a flat left join (a `many` relation, or
   * one with its own joins): read the related rows in one extra query, then
   * group them by the columns the relation joins on.
   */
  const runSubQueryJoin: (
    records: ReadonlyArray<Row>,
    join: CompiledJoin,
  ) => Effect.Effect<void, OrmError, SqlClient> = Effect.fnUntraced(function* (
    records: ReadonlyArray<Row>,
    join: CompiledJoin,
  ) {
    const { options: joinOptions, relation } = join;
    if (joinOptions === false || records.length === 0) {
      for (const record of records) record[relation.name] = relation.type === "one" ? null : [];
      return;
    }
    const selectBuilder = extendSelect(joinOptions.select);
    for (const [, right] of relation.on) selectBuilder.extend(right);
    const compiledSelect = selectBuilder.compile();

    // One condition per distinct key. A NULL join value can never match, so
    // rows carrying one are left out. Single-column relations use one IN
    // list; composite ones an OR of ANDs. Both are chunked to stay under the
    // provider's parameter and expression-depth limits.
    const conditions: Array<Condition> = [];
    const pair = relation.on.length === 1 ? relation.on[0] : undefined;
    if (pair !== undefined) {
      const [left, right] = pair;
      const column = yield* columnOf(relation.table, right);
      const keys = new Map<unknown, unknown>();
      for (const record of records) {
        const value = record[left];
        if (!isAbsentKey(value)) keys.set(keyPart(value), value);
      }
      for (const group of chunk([...keys.values()], parameterBudget(provider))) {
        conditions.push(Condition.Compare({ column, operator: "in", value: group }));
      }
    } else {
      const branches: Array<Condition> = [];
      const seen = new Set<string>();
      for (const record of records) {
        const items: Array<Condition> = [];
        let containsNull = false;
        for (const [left, right] of relation.on) {
          const value = record[left];
          if (isAbsentKey(value)) {
            containsNull = true;
            break;
          }
          items.push(
            Condition.Compare({
              column: yield* columnOf(relation.table, right),
              operator: "=",
              value,
            }),
          );
        }
        if (containsNull) continue;
        const key = JSON.stringify(
          relation.on.map(([left]) => record[left]),
          (_, v: unknown) => keyPart(v),
        );
        if (seen.has(key)) continue;
        seen.add(key);
        branches.push(Condition.And({ items }));
      }
      const perChunk = Math.max(
        1,
        Math.floor(Math.min(parameterBudget(provider), 900) / relation.on.length),
      );
      for (const group of chunk(branches, perChunk))
        conditions.push(Condition.Or({ items: group }));
    }

    const subRecords: Array<Row> = [];
    for (const root of conditions) {
      subRecords.push(
        ...(yield* findManyImpl(relation.table, {
          ...joinOptions,
          select: compiledSelect.result,
          where:
            joinOptions.where === undefined
              ? root
              : Condition.And({ items: [root, joinOptions.where] }),
        })),
      );
    }

    for (const record of records) {
      const matched = subRecords.filter((subRecord) => matches(record, subRecord, relation));
      record[relation.name] = relation.type === "one" ? (matched[0] ?? null) : matched;
    }
    for (const subRecord of subRecords) compiledSelect.removeExtendedKeys(subRecord);
  });

  // Join keys are decoded values, so a `DateTime` or `Uint8Array` key needs structural equality.
  const matches = (record: Row, subRecord: Row, relation: AnyRelation): boolean =>
    relation.on.every(([left, right]) => Equal.equals(record[left], subRecord[right]));

  const findFirstImpl: (
    table: AnyTable,
    options: CompiledFindOptions,
  ) => Effect.Effect<Row | null, OrmError, SqlClient> = Effect.fn("FumaDB.SqlQuery.findFirst")(
    function* (table: AnyTable, options: CompiledFindOptions) {
      const records = yield* findManyImpl(table, { ...options, limit: 1 });
      return records[0] ?? null;
    },
  );

  const countImpl: (
    table: AnyTable,
    options: { readonly where: Condition | undefined },
  ) => Effect.Effect<number, OrmError, SqlClient> = Effect.fn("FumaDB.SqlQuery.count")(function* (
    table: AnyTable,
    options: { readonly where: Condition | undefined },
  ) {
    const sql = yield* SqlClient;
    const parts: Array<Statement.Fragment> = [
      sql`SELECT COUNT(*) AS ${sql("count")} FROM ${sql(table.names.sql)}`,
    ];
    if (options.where !== undefined) parts.push(yield* whereClause(sql, options.where));
    const rows = yield* sql<RawRow>`${spaced(parts)}`;
    const raw = rows[0]?.["count"];
    const count = Number(raw);
    if (!Number.isFinite(count)) {
      return yield* new QueryError({
        reason: "UnexpectedResult",
        message: `unexpected result for count, received: ${String(raw)}`,
        table: table.ormName,
      });
    }
    return count;
  });

  /** Read one row back by its id, for providers or statements without a returning clause. */
  const selectById: (
    table: AnyTable,
    id: unknown,
  ) => Effect.Effect<Row | undefined, OrmError, SqlClient> = Effect.fnUntraced(function* (
    table: AnyTable,
    id: unknown,
  ) {
    const records = yield* findManyImpl(table, {
      select: true,
      computed: [],
      where: Condition.Compare({ column: table.getIdColumn(), operator: "=", value: id }),
      orderBy: undefined,
      join: undefined,
      limit: 1,
      offset: undefined,
    });
    return records[0];
  });

  /**
   * A value in an MSSQL statement: `NULL` as a literal (see `insertFragment`),
   * an empty byte array as `0x` (tedious rejects a zero-length `varbinary`
   * parameter), anything else bound as a parameter.
   */
  const mssqlValue = (sql: SqlClient, value: unknown): Statement.Fragment => {
    if (value === null || value === undefined) return sql.literal("NULL");
    if (value instanceof Uint8Array && value.byteLength === 0) return sql.literal("0x");
    return sql`${value}`;
  };

  /** `col = value, ...` for an UPDATE; MSSQL renders nulls and empty binaries as literals. */
  const assignments = (sql: SqlClient, encoded: Record<string, unknown>): Statement.Fragment =>
    provider === "mssql"
      ? sql.csv(
          Object.entries(encoded).map(
            ([column, value]) => sql`${sql(column)} = ${mssqlValue(sql, value)}`,
          ),
        )
      : sql`${sql.update(encoded)}`;

  /**
   * The `(columns) VALUES (...)` part of an insert, with an optional
   * `RETURNING` / `OUTPUT` list.
   *
   * MSSQL gets its own rendering: the Effect driver binds every `null`
   * parameter as `bit`, so a multi-row insert that mixes `NULL` with text in
   * one column fails with "Conversion failed ... to data type bit". Rendering
   * `NULL` as a literal sidesteps the parameter type entirely. The other
   * providers use the driver's insert helper.
   */
  const insertFragment = (
    sql: SqlClient,
    rows: ReadonlyArray<Record<string, unknown>>,
    returning: Statement.Fragment | undefined,
  ): Statement.Fragment => {
    const aligned = alignColumns(rows);
    if (provider !== "mssql") {
      const helper = sql.insert(aligned);
      return sql`${returning === undefined ? helper : helper.returning(returning)}`;
    }
    const first = aligned[0];
    const columns = first === undefined ? [] : Object.keys(first);
    const columnList = sql.csv(columns.map((column) => sql`${sql(column)}`));
    const valueList = sql.csv(
      aligned.map(
        (row) => sql`(${sql.csv(columns.map((column) => mssqlValue(sql, row[column])))})`,
      ),
    );
    return returning === undefined
      ? sql`(${columnList}) VALUES ${valueList}`
      : sql`(${columnList}) OUTPUT ${returning} VALUES ${valueList}`;
  };

  /**
   * Give every row the same columns, because one multi-row `INSERT` has a
   * single column list. A column another row sets is inserted as `NULL` here.
   */
  const alignColumns = (
    rows: ReadonlyArray<Record<string, unknown>>,
  ): Array<Record<string, unknown>> => {
    const keys = new Set<string>();
    for (const row of rows) for (const key of Object.keys(row)) keys.add(key);
    return rows.map((row) => {
      const out: Record<string, unknown> = {};
      for (const key of keys) out[key] = row[key] ?? null;
      return out;
    });
  };

  const createImpl: (table: AnyTable, values: Row) => Effect.Effect<Row, OrmError, SqlClient> =
    Effect.fn("FumaDB.SqlQuery.create")(function* (table: AnyTable, values: Row) {
      const sql = yield* SqlClient;
      const prepared = yield* prepareValues(table, values, true);

      if (provider !== "mysql") {
        const returning = provider === "mssql" ? outputList(sql, table) : returningList(sql, table);
        const rows =
          yield* sql<RawRow>`INSERT INTO ${sql(table.names.sql)} ${insertFragment(sql, [prepared.encoded], returning)}`;
        const row = rows[0];
        if (row === undefined) {
          return yield* new QueryError({
            reason: "UnexpectedResult",
            message: "the database didn't return the created row.",
            table: table.ormName,
          });
        }
        return yield* Effect.fromResult(decodeResult(row, table));
      }

      const idColumn = table.getIdColumn();
      const id = prepared.values[idColumn.ormName];
      if (id === undefined || id === null) {
        return yield* new QueryError({
          reason: "MissingIdValue",
          message: "cannot find value of id column, which is required for `create()`.",
          table: table.ormName,
          column: idColumn.ormName,
        });
      }
      yield* sql`INSERT INTO ${sql(table.names.sql)} ${insertFragment(sql, [prepared.encoded], undefined)}`;
      const row = yield* selectById(table, id);
      if (row === undefined) {
        return yield* new QueryError({
          reason: "UnexpectedResult",
          message: "the created row could not be read back.",
          table: table.ormName,
        });
      }
      return row;
    });

  const createManyImpl: (
    table: AnyTable,
    values: ReadonlyArray<Row>,
  ) => Effect.Effect<Array<{ readonly _id: unknown }>, OrmError, SqlClient> = Effect.fn(
    "FumaDB.SqlQuery.createMany",
  )(function* (table: AnyTable, values: ReadonlyArray<Row>) {
    if (values.length === 0) return [];
    const sql = yield* SqlClient;
    const prepared = yield* Effect.forEach(values, (value) => prepareValues(table, value, true));
    const encoded = prepared.map((item) => item.encoded);
    // One INSERT per parameter budget; several chunks run in one transaction so the batch stays atomic.
    const columnCount = Math.max(1, Object.keys(table.columns).length);
    const rowsPerStatement = Math.max(1, Math.floor(parameterBudget(provider) / columnCount));
    const chunks = chunk(encoded, rowsPerStatement);
    const insertAll = Effect.forEach(
      chunks,
      (rows) => sql`INSERT INTO ${sql(table.names.sql)} ${insertFragment(sql, rows, undefined)}`,
      { discard: true },
    );
    yield* chunks.length > 1 ? sql.withTransaction(insertAll) : insertAll;
    const idName = table.getIdColumn().names.sql;
    return encoded.map((row) => ({ _id: row[idName] }));
  });

  const updateManyImpl: (
    table: AnyTable,
    options: { readonly where: Condition | undefined; readonly set: Row },
  ) => Effect.Effect<void, OrmError, SqlClient> = Effect.fn("FumaDB.SqlQuery.updateMany")(
    function* (
      table: AnyTable,
      options: { readonly where: Condition | undefined; readonly set: Row },
    ) {
      const sql = yield* SqlClient;
      const prepared = yield* prepareValues(table, options.set, false);
      if (Object.keys(prepared.encoded).length === 0) return;
      const parts: Array<Statement.Fragment> = [
        sql`UPDATE ${sql(table.names.sql)} SET ${assignments(sql, prepared.encoded)}`,
      ];
      if (options.where !== undefined) parts.push(yield* whereClause(sql, options.where));
      yield* sql`${spaced(parts)}`;
    },
  );

  const deleteManyImpl: (
    table: AnyTable,
    options: { readonly where: Condition | undefined },
  ) => Effect.Effect<void, OrmError, SqlClient> = Effect.fn("FumaDB.SqlQuery.deleteMany")(
    function* (table: AnyTable, options: { readonly where: Condition | undefined }) {
      const sql = yield* SqlClient;
      const parts: Array<Statement.Fragment> = [sql`DELETE FROM ${sql(table.names.sql)}`];
      if (options.where !== undefined) parts.push(yield* whereClause(sql, options.where));
      yield* sql`${spaced(parts)}`;
    },
  );

  /** Update the row with this id, returning it when `returning` is set. */
  const updateById: (
    table: AnyTable,
    id: unknown,
    update: Row,
    returning: boolean,
  ) => Effect.Effect<Row | undefined, OrmError, SqlClient> = Effect.fnUntraced(function* (
    table: AnyTable,
    id: unknown,
    update: Row,
    returning: boolean,
  ) {
    const sql = yield* SqlClient;
    const idColumn = table.getIdColumn();
    const where = Condition.Compare({ column: idColumn, operator: "=", value: id });
    const prepared = yield* prepareValues(table, update, false);
    if (Object.keys(prepared.encoded).length === 0) {
      return returning ? yield* selectById(table, id) : undefined;
    }

    if (
      returning &&
      (provider === "postgresql" || provider === "cockroachdb" || provider === "sqlite")
    ) {
      const rows =
        yield* sql<RawRow>`UPDATE ${sql(table.names.sql)} SET ${sql.update(prepared.encoded)} ${yield* whereClause(
          sql,
          where,
        )} RETURNING ${returningList(sql, table)}`;
      const row = rows[0];
      return row === undefined ? undefined : yield* Effect.fromResult(decodeResult(row, table));
    }

    if (returning && provider === "mssql") {
      const rows =
        yield* sql<RawRow>`UPDATE ${sql(table.names.sql)} SET ${assignments(sql, prepared.encoded)} OUTPUT ${outputList(
          sql,
          table,
        )} ${yield* whereClause(sql, where)}`;
      const row = rows[0];
      return row === undefined ? undefined : yield* Effect.fromResult(decodeResult(row, table));
    }

    yield* updateManyImpl(table, { where, set: update });
    return returning ? yield* selectById(table, id) : undefined;
  });

  const upsertImpl: (
    table: AnyTable,
    options: CompiledUpsert,
  ) => Effect.Effect<Row | undefined, OrmError, SqlClient> = Effect.fn("FumaDB.SqlQuery.upsert")(
    function* (table: AnyTable, options: CompiledUpsert) {
      const sql = yield* SqlClient;
      const idColumn = table.getIdColumn();
      const prepared = yield* prepareValues(table, options.update, false);

      // MSSQL has no row count on `.raw`, so the update reports itself through
      // `OUTPUT INSERTED`: one round trip when a row already exists.
      if (provider === "mssql" && Object.keys(prepared.encoded).length > 0) {
        const output = options.returning
          ? outputList(sql, table)
          : sql`${sql(`INSERTED.${idColumn.names.sql}`)} AS ${sql(idColumn.ormName)}`;
        const parts: Array<Statement.Fragment> = [
          sql`UPDATE TOP (1) ${sql(table.names.sql)} SET ${assignments(sql, prepared.encoded)} OUTPUT ${output}`,
        ];
        if (options.where !== undefined) parts.push(yield* whereClause(sql, options.where));
        const rows = yield* sql<RawRow>`${spaced(parts)}`;
        const row = rows[0];
        if (row !== undefined)
          return options.returning ? yield* Effect.fromResult(decodeResult(row, table)) : undefined;
        if (options.returning) return yield* createImpl(table, options.create);
        yield* createManyImpl(table, [options.create]);
        return undefined;
      }

      const existing = yield* findManyImpl(table, {
        select: [idColumn.ormName],
        computed: [],
        where: options.where,
        orderBy: undefined,
        join: undefined,
        limit: 1,
        offset: undefined,
      });
      const found = existing[0];
      if (found === undefined) {
        if (options.returning) return yield* createImpl(table, options.create);
        yield* createManyImpl(table, [options.create]);
        return undefined;
      }
      return yield* updateById(table, found[idColumn.ormName], options.update, options.returning);
    },
  );

  return {
    tables: schema.tables,
    count: countImpl,
    findFirst: findFirstImpl,
    findMany: findManyImpl,
    updateMany: updateManyImpl,
    upsert: upsertImpl,
    create: createImpl,
    createMany: createManyImpl,
    deleteMany: deleteManyImpl,
    transaction: (effect) => Effect.flatMap(SqlClient, (sql) => sql.withTransaction(effect)),
  };
};
