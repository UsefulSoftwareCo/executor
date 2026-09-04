import * as Drizzle from "drizzle-orm";
import type * as PostgreSQL from "drizzle-orm/pg-core";
import type { AbstractQuery, FindManyOptions } from "../../query";
import { type Condition, ConditionType } from "../../query/condition-builder";
import { type SimplifyFindOptions, toORM } from "../../query/orm";
import {
  type AnyColumn,
  type AnySchema,
  type AnyTable,
  Column,
} from "../../schema";
import type { SQLProvider } from "../../shared/providers";
import { type ColumnType, parseDrizzle, type TableType } from "./shared";

/** Thrown inside a `replaceMany` transaction to abort it when the guard
 *  matched no row; caught at the boundary and reported as `applied: false`. */
class ReplaceGuardMiss extends Error {
  constructor() {
    super("replaceMany guard matched no row");
    this.name = "ReplaceGuardMiss";
  }
}

type P_TableType = PostgreSQL.PgTableWithColumns<PostgreSQL.TableConfig>;
type P_ColumnType = PostgreSQL.AnyPgColumn;
type P_DBType = PostgreSQL.PgDatabase<
  PostgreSQL.PgQueryResultHKT,
  Record<string, unknown>,
  Drizzle.TablesRelationalConfig
>;

const CREATE_MANY_BATCH_SIZE = 500;

// A multi-row write binds (rows * columns) parameters in one statement, and
// engines cap bound parameters per statement (older SQLite: 999, Cloudflare
// D1: 100). When the adapter does not advertise its limit, budget against the
// conservative 999 floor so a wide table cannot overflow with "too many SQL
// variables" on stricter engines.
const DEFAULT_MAX_BOUND_PARAMETERS = 999;

function parameterBoundedBatchSize(
  table: AnyTable,
  columnsPerRow: number,
  reservedParameters: number,
  maxBoundParameters: number | undefined
): number {
  const budget = maxBoundParameters ?? DEFAULT_MAX_BOUND_PARAMETERS;
  const rowsPerStatement = Math.floor((budget - reservedParameters) / columnsPerRow);
  if (rowsPerStatement < 1) {
    // Even a single row cannot fit the advertised budget. Clamping to one row
    // anyway would silently emit a statement the engine may reject, so fail
    // fast and name the numbers instead.
    const reservedNote =
      reservedParameters > 0 ? ` and the predicate reserves ${reservedParameters} more` : "";
    // oxlint-disable-next-line executor/no-try-catch-or-throw, executor/no-error-constructor -- boundary: adapter rejects writes that cannot fit the engine's bound-parameter budget
    throw new Error(
      `[FumaDB Drizzle] Cannot write table "${table.ormName}": one row binds ${columnsPerRow} bound parameters${reservedNote}, which exceeds the ${budget}-parameter budget per statement.`
    );
  }
  return Math.min(CREATE_MANY_BATCH_SIZE, rowsPerStatement);
}

// SQLite transaction scopes run as raw BEGIN/SAVEPOINT statements on one
// shared connection, so two scopes started concurrently would interleave
// their control statements: two top-level BEGINs collide, and sibling
// savepoints at one nesting depth reuse each other's names — one sibling's
// ROLLBACK TO can undo work the other already released. Serialize scope
// execution per connection handle and nesting depth: same-depth scopes run
// one after another, while a parent scope at depth N can still open its
// child scope at depth N + 1 without deadlocking. SQLite is single-writer,
// so this serialization costs no real concurrency.
const transactionScopeQueues = new WeakMap<object, Map<number, Promise<void>>>();

async function runSerializedScope<T>(
  handle: object,
  depth: number,
  fn: () => Promise<T>,
): Promise<T> {
  let queues = transactionScopeQueues.get(handle);
  if (!queues) {
    queues = new Map();
    transactionScopeQueues.set(handle, queues);
  }
  const previous = queues.get(depth) ?? Promise.resolve();
  let release!: () => void;
  queues.set(
    depth,
    new Promise<void>((resolve) => {
      release = resolve;
    }),
  );
  await previous;
  // oxlint-disable-next-line executor/no-try-catch-or-throw -- scope release must survive the wrapped failure
  try {
    return await fn();
  } finally {
    release();
  }
}

// Savepoint names are invocation-unique as defense in depth: even if two
// scopes ever interleave, a ROLLBACK TO can only target its own savepoint.
let savepointSequence = 0;

function buildWhere(
  toDrizzle: (col: AnyColumn) => ColumnType,
  condition: Condition
): Drizzle.SQL | undefined {
  if (condition.type === ConditionType.Compare) {
    const left = toDrizzle(condition.a);
    const op = condition.operator;
    let right = condition.b;
    if (right instanceof Column) right = toDrizzle(right);
    let inverse = false;

    switch (op) {
      case "=":
        return Drizzle.eq(left, right);
      case "!=":
        return Drizzle.ne(left, right);
      case ">":
        return Drizzle.gt(left, right);
      case ">=":
        return Drizzle.gte(left, right);
      case "<":
        return Drizzle.lt(left, right);
      case "<=":
        return Drizzle.lte(left, right);
      case "in": {
        // @ts-expect-error -- skip type check
        return Drizzle.inArray(left, right);
      }
      case "not in":
        // @ts-expect-error -- skip type check
        return Drizzle.notInArray(left, right);
      case "is":
        return right === null ? Drizzle.isNull(left) : Drizzle.eq(left, right);
      case "is not":
        return right === null
          ? Drizzle.isNotNull(left)
          : Drizzle.ne(left, right);
      case "not contains":
        inverse = true;
      case "contains":
        right =
          typeof right === "string"
            ? `%${right}%`
            : Drizzle.sql`concat('%', ${right}, '%')`;

        return inverse
          ? // @ts-expect-error -- skip type check
            Drizzle.notLike(left, right)
          : // @ts-expect-error -- skip type check
            Drizzle.like(left, right);
      case "not ends with":
        inverse = true;
      case "ends with":
        right =
          typeof right === "string"
            ? `%${right}`
            : Drizzle.sql`concat('%', ${right})`;

        return inverse
          ? // @ts-expect-error -- skip type check
            Drizzle.notLike(left, right)
          : // @ts-expect-error -- skip type check
            Drizzle.like(left, right);
      case "not starts with":
        inverse = true;
      case "starts with":
        right =
          typeof right === "string"
            ? `${right}%`
            : Drizzle.sql`concat(${right}, '%')`;

        return inverse
          ? // @ts-expect-error -- skip type check
            Drizzle.notLike(left, right)
          : // @ts-expect-error -- skip type check
            Drizzle.like(left, right);

      default:
        throw new Error(`Unsupported operator: ${op}`);
    }
  }

  if (condition.type === ConditionType.And)
    return Drizzle.and(
      ...condition.items.map((item) => buildWhere(toDrizzle, item))
    );

  if (condition.type === ConditionType.Not) {
    const result = buildWhere(toDrizzle, condition.item);
    if (!result) return;

    return Drizzle.not(result);
  }

  return Drizzle.or(
    ...condition.items.map((item) => buildWhere(toDrizzle, item))
  );
}

function countConditionParameters(condition: Condition): number {
  if (condition.type === ConditionType.Compare) {
    if (condition.b instanceof Column) return 0;
    if (Array.isArray(condition.b)) return condition.b.length;
    return 1;
  }
  if (condition.type === ConditionType.Not) return countConditionParameters(condition.item);
  return condition.items.reduce((count, item) => count + countConditionParameters(item), 0);
}

function mapValues(
  values: Record<string, unknown>,
  table: AnyTable
): Record<string, unknown> {
  const out: Record<string, unknown> = {};

  for (const column of Object.values(table.columns)) {
    out[column.names.drizzle] = values[column.ormName];
  }

  return out;
}

function mapQueryResult(table: AnyTable, result: Record<string, unknown>) {
  const out: Record<string, unknown> = {};

  for (const k in result) {
    const value = result[k];

    if (k in table.relations) {
      const relation = table.relations[k];

      if (relation.type === "many") {
        out[k] = (value as Record<string, unknown>[]).map((v) =>
          mapQueryResult(relation.table, v)
        );
        continue;
      }

      out[k] = value ? mapQueryResult(relation.table, value as any) : null;
      continue;
    }

    const col = table.getColumnByName(k, "drizzle");
    if (!col) continue;
    out[col.ormName] = value;
  }

  return out;
}

// TODO: Support binary data in relation queries, because Drizzle doesn't support it: https://github.com/drizzle-team/drizzle-orm/issues/3497
/**
 * Require drizzle query mode, make sure to configure it first. (including the `schema` option)
 */
export function fromDrizzle(
  schema: AnySchema,
  _db: unknown,
  provider: SQLProvider,
  interactiveTransactions: boolean = true,
  maxBoundParameters?: number,
  transactionDepth: number = 0
): AbstractQuery<AnySchema> {
  const [db, drizzleTables] = parseDrizzle(_db);

  async function executeRaw(statement: string) {
    const target = db as unknown as {
      run?: (query: Drizzle.SQL) => unknown;
      execute?: (query: Drizzle.SQL) => Promise<unknown>;
    };
    const query = Drizzle.sql.raw(statement);

    if (target.run) {
      await target.run(query);
      return;
    }

    if (target.execute) {
      await target.execute(query);
      return;
    }

    throw new Error("[FumaDB Drizzle] Database cannot execute raw transaction statements.");
  }

  // Runs `fn` atomically when the engine allows it. SQLite drivers get raw
  // BEGIN/COMMIT on the shared connection — or a SAVEPOINT when this adapter
  // instance already lives inside a transaction, so nested use (e.g. a bulk
  // upsert splitting into predicate groups inside a caller's transaction)
  // does not issue a second BEGIN. Other providers get a driver transaction
  // whose handle must be used for every statement inside `fn`. When the
  // engine rejects interactive transactions (Cloudflare D1), statements
  // auto-commit — that engine constraint is documented on `transaction`.
  async function runAtomically<T>(fn: (handle: typeof db) => Promise<T>): Promise<T> {
    if (!interactiveTransactions) {
      return fn(db);
    }
    if (provider === "sqlite") {
      return runSerializedScope(db, transactionDepth, async () => {
        savepointSequence += 1;
        const savepoint = transactionDepth > 0 ? `fumadb_tx_${savepointSequence}` : undefined;
        await executeRaw(savepoint ? `SAVEPOINT ${savepoint}` : "BEGIN");
        try {
          const result = await fn(db);
          await executeRaw(savepoint ? `RELEASE SAVEPOINT ${savepoint}` : "COMMIT");
          return result;
        } catch (e) {
          if (savepoint) {
            await executeRaw(`ROLLBACK TO SAVEPOINT ${savepoint}`);
            await executeRaw(`RELEASE SAVEPOINT ${savepoint}`);
          } else {
            await executeRaw("ROLLBACK");
          }
          throw e;
        }
      });
    }
    return db.transaction((tx) => fn(tx as unknown as typeof db));
  }

  function toDrizzle(v: AnyTable): TableType {
    const out = drizzleTables[v.names.drizzle];
    if (out) return out;

    throw new Error(
      `[FumaDB Drizzle] Unknown table name ${v.names.drizzle}, is it included in your Drizzle schema?`
    );
  }

  function toDrizzleColumn(v: AnyColumn): ColumnType {
    const table = toDrizzle(v.table!);
    const out = table[v.names.drizzle];
    if (out) return out;

    throw new Error(
      `[FumaDB Drizzle] Unknown column name ${v.names.drizzle} in ${v.table.names.drizzle}.`
    );
  }

  // Drizzle Queries doesn't support renaming fields with `mapWith` because https://github.com/drizzle-team/drizzle-orm/issues/1157
  // we need to map the result on JS instead of relying on Drizzle
  function buildQueryConfig(
    table: AnyTable,
    options: SimplifyFindOptions<FindManyOptions>
  ) {
    const columns: Record<string, boolean> = {};
    const select = options.select;

    if (select === true) {
      for (const col of Object.values(table.columns)) {
        columns[col.names.drizzle] = true;
      }
    } else {
      for (const k of select) {
        columns[table.columns[k].names.drizzle] = true;
      }
    }

    const out: Drizzle.DBQueryConfig<"many" | "one", boolean> = {
      columns,
      limit: options.limit,
      offset: options.offset,
      where: options.where
        ? buildWhere(toDrizzleColumn, options.where)
        : undefined,
      orderBy: options.orderBy?.map(([item, mode]) =>
        mode === "asc"
          ? Drizzle.asc(toDrizzleColumn(item))
          : Drizzle.desc(toDrizzleColumn(item))
      ),
    };

    if (options.join) {
      out.with = {};

      for (const join of options.join) {
        if (join.options === false) continue;

        out.with[join.relation.name] = buildQueryConfig(
          join.relation.table,
          join.options
        );
      }
    }

    return out;
  }

  return toORM({
    tables: schema.tables,
    async count(table, v) {
      return await db.$count(
        toDrizzle(table),
        v.where ? buildWhere(toDrizzleColumn, v.where) : undefined
      );
    },
    async findFirst(table, v) {
      const results = await this.findMany(table, {
        ...v,
        limit: 1,
      });

      return results[0] ?? null;
    },

    async upsert(table, v) {
      const idField = table.getIdColumn().names.drizzle;
      const drizzleTable = toDrizzle(table);
      let query = db
        .select({ id: drizzleTable[idField] })
        .from(drizzleTable)
        .limit(1);

      if (v.where) {
        query = query.where(buildWhere(toDrizzleColumn, v.where)) as any;
      }

      const targetIds = await query.execute();

      if (targetIds.length > 0) {
        await db
          .update(drizzleTable)
          .set(mapValues(v.update, table))
          .where(Drizzle.eq(drizzleTable[idField], targetIds[0].id));
      } else {
        await this.createMany(table, [v.create]);
      }
    },
    async upsertMany(table, v) {
      if (v.values.length === 0) return;
      if (v.target.length === 0) {
        // oxlint-disable-next-line executor/no-try-catch-or-throw, executor/no-error-constructor -- boundary: adapter rejects invalid upsert shape
        throw new Error("[FumaDB] upsertMany requires at least one target column.");
      }
      if (v.update.length === 0) {
        // oxlint-disable-next-line executor/no-try-catch-or-throw, executor/no-error-constructor -- boundary: adapter rejects invalid upsert shape
        throw new Error("[FumaDB] upsertMany requires at least one update column.");
      }
      if (provider !== "sqlite" && provider !== "postgresql") {
        // This path issues several statements per row, so a failure halfway
        // through must not leave a prefix of the rows committed. These
        // providers have native driver transactions; `transaction` routes
        // every per-row statement through one of them.
        await this.transaction(async (scoped) => {
          for (const value of v.values) {
            const targetCondition: Condition = {
              type: ConditionType.And,
              items: v.target.map((column) => ({
                type: ConditionType.Compare,
                a: column,
                operator: "=",
                b: value[column.ormName],
              })),
            };
            await scoped.internal.upsert(table, {
              where: v.where
                ? { type: ConditionType.And, items: [targetCondition, v.where] }
                : targetCondition,
              update: Object.fromEntries(
                v.update.map((column) => [column.ormName, value[column.ormName]]),
              ),
              create: value,
            });
          }
        });
        return;
      }

      const drizzleTable = toDrizzle(table);
      const values = v.values.map((value) => mapValues(value, table));
      const where = v.where ? buildWhere(toDrizzleColumn, v.where) : undefined;
      const whereParameters = v.where ? countConditionParameters(v.where) : 0;
      const columnsPerRow = values.length > 0 ? Math.max(1, Object.keys(values[0]!).length) : 1;
      const batchSize = parameterBoundedBatchSize(
        table,
        columnsPerRow,
        whereParameters,
        maxBoundParameters,
      );
      const target = v.target.map((column) => drizzleTable[column.names.drizzle]);
      const set = Object.fromEntries(
        v.update.map((column) => [
          column.names.drizzle,
          // `sql.identifier` quotes the physical column name; a raw
          // interpolation would emit e.g. `excluded.display-name` unquoted,
          // which the engine parses as an expression.
          Drizzle.sql`excluded.${Drizzle.sql.identifier(column.names.sql)}`,
        ]),
      );

      const buildStatements = (handle: typeof db): unknown[] => {
        const statements: unknown[] = [];
        for (let i = 0; i < values.length; i += batchSize) {
          const batch = values.slice(i, i + batchSize);
          const insert = handle.insert(drizzleTable).values(batch) as unknown as {
            onConflictDoUpdate: (input: {
              readonly target: typeof target;
              readonly set: typeof set;
              readonly where?: typeof where;
            }) => unknown;
          };
          statements.push(
            insert.onConflictDoUpdate({
              target,
              set,
              ...(where === undefined ? {} : { where }),
            }),
          );
        }
        return statements;
      };
      const executeStatements = async (handle: typeof db) => {
        for (const statement of buildStatements(handle)) {
          await statement;
        }
      };
      const statementCount = Math.ceil(values.length / batchSize);

      // D1 rejects interactive transactions but its native batch API executes
      // prepared statements as one transaction. Drizzle exposes that API on
      // the database handle, so keep parameter-bounded upserts atomic instead
      // of auto-committing each statement independently.
      const nativeBatch = db as unknown as {
        readonly batch?: (statements: readonly unknown[]) => Promise<unknown>;
      };
      if (!interactiveTransactions && statementCount > 1 && nativeBatch.batch) {
        await nativeBatch.batch(buildStatements(db));
        return;
      }

      if (statementCount === 1) {
        await executeStatements(db);
        return;
      }

      // One logical upsert split into several parameter-bounded statements
      // stays atomic: run them inside one transaction.
      await runAtomically(executeStatements);
    },
    async findMany(table, v) {
      return (
        await db.query[table.names.drizzle].findMany(buildQueryConfig(table, v))
      ).map((v) => mapQueryResult(table, v));
    },

    async updateMany(table, v) {
      const drizzleTable = toDrizzle(table);

      let query = db.update(drizzleTable).set(mapValues(v.set, table));

      if (v.where) {
        query = query.where(buildWhere(toDrizzleColumn, v.where)) as any;
      }

      await query;
    },

    async create(table, values) {
      const idField = table.getIdColumn().names.drizzle;
      const drizzleTable = toDrizzle(table);
      values = mapValues(values, table);

      const returning: Record<string, ColumnType> = {};
      for (const column of Object.values(table.columns)) {
        returning[column.ormName] = drizzleTable[column.names.drizzle];
      }

      if (provider === "sqlite" || provider === "postgresql") {
        const result = await (db as unknown as P_DBType)
          .insert(drizzleTable as unknown as P_TableType)
          .values(values)
          .returning(returning as unknown as Record<string, P_ColumnType>);
        return result[0];
      }

      const obj = (
        await db.insert(drizzleTable).values(values).$returningId()
      )[0] as Record<string, unknown>;

      return (
        await db
          .select(returning)
          .from(drizzleTable)
          .where(Drizzle.eq(drizzleTable[idField], obj[idField]))
          .limit(1)
      )[0];
    },

    async createMany(table, values) {
      if (values.length === 0) return [];
      const idField = table.getIdColumn().names.drizzle;
      const drizzleTable = toDrizzle(table);
      values = values.map((v) => mapValues(v, table));
      const columnsPerRow = Math.max(1, Object.keys(values[0]!).length);
      const batchSize = parameterBoundedBatchSize(table, columnsPerRow, 0, maxBoundParameters);
      const batches: (typeof values)[] = [];
      for (let i = 0; i < values.length; i += batchSize) {
        batches.push(values.slice(i, i + batchSize));
      }

      const insertBatches = async (handle: typeof db): Promise<{ _id: unknown }[]> => {
        if (provider === "sqlite" || provider === "postgresql") {
          const out: { _id: unknown }[] = [];
          for (const batch of batches) {
            out.push(
              ...(await (handle as unknown as P_DBType)
                .insert(drizzleTable as unknown as P_TableType)
                .values(batch)
                .returning({
                  _id: (drizzleTable as unknown as P_TableType)[idField],
                })),
            );
          }
          return out;
        }

        const results: Record<string, unknown>[] = [];
        for (const batch of batches) {
          results.push(...(await handle.insert(drizzleTable).values(batch).$returningId()));
        }
        return results.map((result) => ({ _id: result[idField] }));
      };

      if (batches.length === 1) return insertBatches(db);
      // One logical insert split into parameter-bounded statements must stay
      // atomic: a later batch's constraint failure rolls back the earlier
      // batches. (Engines without interactive transactions auto-commit each
      // statement; `createMany` needs the inserted ids back, which the native
      // batch API's result shape does not guarantee across drivers, so those
      // engines keep sequential statements — their documented constraint.)
      return runAtomically(insertBatches);
    },

    async deleteMany(table, v) {
      const drizzleTable = toDrizzle(table);
      let query = db.delete(drizzleTable);

      if (v.where) {
        query = query.where(buildWhere(toDrizzleColumn, v.where)) as any;
      }

      await query;
    },
    async replaceMany(plan) {
      // Every statement of the plan, built against one handle: the guard
      // update first, then the deletes, then parameter-bounded insert batches.
      const buildStatements = (handle: typeof db): unknown[] => {
        const statements: unknown[] = [];
        if (plan.guard) {
          const guardTable = toDrizzle(plan.guard.table);
          let update = handle.update(guardTable).set(mapValues(plan.guard.set, plan.guard.table));
          if (plan.guard.where) {
            update = update.where(buildWhere(toDrizzleColumn, plan.guard.where)) as any;
          }
          statements.push(update);
        }
        for (const del of plan.deletes) {
          const drizzleTable = toDrizzle(del.table);
          let query = handle.delete(drizzleTable);
          if (del.where) query = query.where(buildWhere(toDrizzleColumn, del.where)) as any;
          statements.push(query);
        }
        for (const ins of plan.inserts) {
          if (ins.values.length === 0) continue;
          const drizzleTable = toDrizzle(ins.table);
          const values = ins.values.map((v) => mapValues(v, ins.table));
          // Drizzle builds a multi-row INSERT over the UNION of every row's
          // columns, so the widest row sets the per-row parameter count.
          const columnsPerRow = Math.max(1, ...values.map((row) => Object.keys(row).length));
          const batchSize = parameterBoundedBatchSize(ins.table, columnsPerRow, 0, maxBoundParameters);
          for (let i = 0; i < values.length; i += batchSize) {
            statements.push(handle.insert(drizzleTable).values(values.slice(i, i + batchSize)));
          }
        }
        return statements;
      };

      // How many rows the guard matched. Drizzle hands back the driver's own
      // result: libsql `rowsAffected`, better-sqlite3 `changes`, node-postgres
      // `rowCount`, postgres.js `count` (a RowList), D1 `meta.changes`, and
      // mysql2 a `[ResultSetHeader, FieldPacket[]]` tuple whose header
      // carries `affectedRows`. A result with NONE of these is a driver this
      // fence does not know, and a fence that cannot read its own guard is
      // not a fence — so that is a hard error, never a silent "matched".
      const guardMatched = (result: unknown): boolean => {
        if (!plan.guard) return true;
        const header =
          Array.isArray(result) && result.length > 0 && result[0] && typeof result[0] === "object"
            ? (result[0] as Record<string, unknown>)
            : undefined;
        if (header && typeof header["affectedRows"] === "number") {
          return (header["affectedRows"] as number) > 0;
        }
        if (result && typeof result === "object") {
          const r = result as Record<string, unknown>;
          for (const key of ["rowsAffected", "changes", "rowCount", "count"]) {
            if (typeof r[key] === "number") return (r[key] as number) > 0;
          }
          const meta = r["meta"];
          if (meta && typeof meta === "object" && typeof (meta as Record<string, unknown>)["changes"] === "number") {
            return ((meta as Record<string, unknown>)["changes"] as number) > 0;
          }
        }
        // oxlint-disable-next-line executor/no-try-catch-or-throw, executor/no-error-constructor -- boundary: adapter refuses to fence on a driver whose update result it cannot read
        throw new Error(
          "[FumaDB Drizzle] replaceMany guard: the driver's update result carries no affected-row count.",
        );
      };

      // D1: no interactive transactions, but the driver's native batch runs
      // every statement in ONE transaction. A batch cannot make its later
      // statements conditional on an earlier one's row count, so the guard
      // runs ALONE first (one statement, atomic, tells us whether we own the
      // row) and only then do the deletes + inserts go through one batch.
      // That is guard-then-batch, not one unit: between the two another
      // writer can re-claim. What a reader sees at each step stays
      // consistent — after our guard the row's manifest names OUR build
      // while the table still holds the old rows, which the reader refuses
      // (count/generation mismatch); once our batch lands, manifest and rows
      // agree and are served; if a re-claimer's guard lands in between, its
      // manifest over our rows is refused until its own batch lands. No
      // half-built or mismatched catalog is ever served.
      const nativeBatch = db as unknown as {
        readonly batch?: (statements: readonly unknown[]) => Promise<unknown[]>;
      };
      if (!interactiveTransactions) {
        if (plan.guard) {
          const guardTable = toDrizzle(plan.guard.table);
          let update = db.update(guardTable).set(mapValues(plan.guard.set, plan.guard.table));
          if (plan.guard.where) {
            update = update.where(buildWhere(toDrizzleColumn, plan.guard.where)) as any;
          }
          const result = await update;
          if (!guardMatched(result)) return { applied: false };
        }
        const rest = buildStatements(db).slice(plan.guard ? 1 : 0);
        if (rest.length === 0) return { applied: true };
        if (nativeBatch.batch) {
          await nativeBatch.batch(rest);
        } else {
          for (const statement of rest) await statement;
        }
        return { applied: true };
      }

      // Interactive engines: one transaction, guard first; a guard that
      // matched nothing rolls the transaction back untouched.
      return runAtomically(async (handle) => {
        const statements = buildStatements(handle);
        if (plan.guard) {
          const result = await statements[0];
          if (!guardMatched(result)) {
            // oxlint-disable-next-line executor/no-try-catch-or-throw, executor/no-error-constructor -- boundary: abort the driver transaction so nothing after a failed guard commits
            throw new ReplaceGuardMiss();
          }
          for (const statement of statements.slice(1)) await statement;
          return { applied: true };
        }
        for (const statement of statements) await statement;
        return { applied: true };
      }).catch((error: unknown) => {
        if (error instanceof ReplaceGuardMiss) return { applied: false };
        throw error;
      });
    },
    async transaction(run) {
      // Some SQLite-compatible engines (Cloudflare D1) reject interactive
      // transactions — both raw BEGIN/COMMIT and the driver's `.transaction()`.
      // When disabled, run the operations directly against the same connection:
      // each statement auto-commits, so there is no atomic rollback (the
      // engine's constraint, not ours). libSQL/Postgres keep real transactions.
      if (!interactiveTransactions) {
        return run(
          fromDrizzle(
            schema,
            _db,
            provider,
            interactiveTransactions,
            maxBoundParameters,
            transactionDepth
          )
        );
      }

      if (provider === "sqlite") {
        return runAtomically(() =>
          run(
            fromDrizzle(
              schema,
              _db,
              provider,
              interactiveTransactions,
              maxBoundParameters,
              transactionDepth + 1
            )
          )
        );
      }

      return db.transaction((tx) =>
        run(
          fromDrizzle(
            schema,
            tx,
            provider,
            interactiveTransactions,
            maxBoundParameters,
            transactionDepth + 1
          )
        )
      );
    },
  });
}
