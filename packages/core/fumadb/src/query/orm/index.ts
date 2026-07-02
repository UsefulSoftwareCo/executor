import type {
  AnyColumn,
  AnyRelation,
  AnySchema,
  AnyTable,
} from "../../schema";
import type {
  AbstractQuery,
  AnySelectClause,
  FindFirstOptions,
  FindManyOptions,
  JoinBuilder,
  OrderBy,
} from "..";
import { buildCondition, createBuilder, type Condition } from "../condition-builder";

export interface CompiledJoin {
  relation: AnyRelation;
  options: SimplifyFindOptions<FindManyOptions> | false;
}

export interface SimplifiedCountOptions {
  where?: Condition | undefined;
}

function isOrderByArray(v: OrderBy | OrderBy[]): v is OrderBy[] {
  return Array.isArray(v) && Array.isArray(v[0]);
}

function simplifyOrderBy(
  columns: Record<string, AnyColumn>,
  orderBy: OrderBy | OrderBy[] | undefined,
): OrderBy<AnyColumn>[] | undefined {
  if (!orderBy || orderBy.length === 0) return;

  if (!isOrderByArray(orderBy)) orderBy = [orderBy];
  return orderBy.map(([name, value]) => {
    const col = columns[name];
    if (!col) throw new Error(`[FumaDB] unknown column name ${name}.`);

    return [col, value];
  });
}

function buildFindOptions(
  table: AnyTable,
  { select = true, where, orderBy, join, ...options }: FindManyOptions,
): SimplifyFindOptions<FindManyOptions> | false {
  let conditions = where ? buildCondition(table.columns, where) : undefined;
  if (conditions === true) conditions = undefined;
  if (conditions === false) return false;

  return {
    select,
    where: conditions,
    orderBy: simplifyOrderBy(table.columns, orderBy),
    join: join ? buildJoin(table, join) : undefined,
    ...options,
  };
}

function buildJoin<T extends AnyTable>(
  table: AnyTable,
  fn: (builder: JoinBuilder<T, {}>) => JoinBuilder<T, unknown>,
): CompiledJoin[] {
  const compiled: CompiledJoin[] = [];
  const builder: Record<string, unknown> = {};

  for (const name in table.relations) {
    const relation = table.relations[name]!;

    builder[name] = (options: FindFirstOptions | FindManyOptions = {}) => {
      compiled.push({
        relation,
        options: buildFindOptions(relation.table, options),
      });

      delete builder[name];
      return builder;
    };
  }

  fn(builder as JoinBuilder<T, {}>);
  return compiled;
}

export type SimplifyFindOptions<O> = Omit<
  O,
  "where" | "orderBy" | "select" | "join"
> & {
  select: AnySelectClause;
  where?: Condition | undefined;
  orderBy?: OrderBy<AnyColumn>[];
  join?: CompiledJoin[];
};

type WriteOperation = "create" | "update" | "upsert";

const mergePolicyCondition = (
  table: AnyTable,
  where: Condition | undefined,
  condition: Condition | boolean | void,
): Condition | undefined | false => {
  if (condition === undefined || condition === true) return where;
  if (condition === false) return false;

  const next = createBuilder(table.columns).and(where ?? true, condition);
  if (next === true) return undefined;
  if (next === false) return false;
  return next;
};

const applyReadPolicies = async (
  table: AnyTable,
  where: Condition | undefined,
  context: unknown,
): Promise<Condition | undefined | false> => {
  let nextWhere = where;

  for (const policy of table.policies) {
    const condition = await policy.onRead?.({
      where: nextWhere,
      context,
      builder: createBuilder(table.columns),
    });
    const merged = mergePolicyCondition(table, nextWhere, condition);
    if (merged === false) return false;
    nextWhere = merged;
  }

  return nextWhere;
};

const applyReadPoliciesToOptions = async (
  table: AnyTable,
  options: SimplifyFindOptions<FindManyOptions>,
  context: unknown,
): Promise<SimplifyFindOptions<FindManyOptions> | false> => {
  const where = await applyReadPolicies(table, options.where, context);
  if (where === false) return false;

  let changed = where !== options.where;
  const join: CompiledJoin[] | undefined = options.join ? [] : undefined;

  for (const entry of options.join ?? []) {
    if (entry.options === false) {
      join!.push(entry);
      continue;
    }

    const nextOptions = await applyReadPoliciesToOptions(
      entry.relation.table,
      entry.options,
      context,
    );
    if (nextOptions === false) {
      join!.push({ ...entry, options: false });
      changed = true;
      continue;
    }
    if (nextOptions !== entry.options) changed = true;
    join!.push(nextOptions === entry.options ? entry : { ...entry, options: nextOptions });
  }

  return changed ? { ...options, where, join } : options;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const applyDeniedJoinDefaults = (
  records: Record<string, unknown>[],
  options: SimplifyFindOptions<FindManyOptions>,
) => {
  if (!options.join) return;

  for (const entry of options.join) {
    if (entry.options === false) {
      for (const record of records) {
        record[entry.relation.name] = entry.relation.type === "many" ? [] : null;
      }
      continue;
    }

    for (const record of records) {
      const value = record[entry.relation.name];
      if (entry.relation.type === "many") {
        if (Array.isArray(value)) applyDeniedJoinDefaults(value.filter(isRecord), entry.options);
        continue;
      }

      if (isRecord(value)) applyDeniedJoinDefaults([value], entry.options);
    }
  }
};

const runCreatePolicies = async (
  table: AnyTable,
  values: Record<string, unknown>,
  context: unknown,
): Promise<void> => {
  for (const policy of table.policies) {
    await policy.onCreate?.({ values, context });
  }
};

const applyUpdatePolicies = async (
  table: AnyTable,
  where: Condition | undefined,
  set: Record<string, unknown>,
  context: unknown,
  operation: Extract<WriteOperation, "update" | "upsert">,
  create?: Record<string, unknown>,
): Promise<Condition | undefined | false> => {
  let nextWhere = where;

  for (const policy of table.policies) {
    const condition = await policy.onUpdate?.({
      where: nextWhere,
      set,
      create,
      context,
      builder: createBuilder(table.columns),
      operation,
    });
    const merged = mergePolicyCondition(table, nextWhere, condition);
    if (merged === false) return false;
    nextWhere = merged;
  }

  return nextWhere;
};

const applyDeletePolicies = async (
  table: AnyTable,
  where: Condition | undefined,
  context: unknown,
): Promise<Condition | undefined | false> => {
  let nextWhere = where;

  for (const policy of table.policies) {
    const condition = await policy.onDelete?.({
      where: nextWhere,
      context,
      builder: createBuilder(table.columns),
    });
    const merged = mergePolicyCondition(table, nextWhere, condition);
    if (merged === false) return false;
    nextWhere = merged;
  }

  return nextWhere;
};

export interface ORMAdapter<S extends AnySchema = AnySchema> {
  tables: S["tables"];
  context?: unknown;
  count: (table: AnyTable, v: SimplifiedCountOptions) => Promise<number>;

  findFirst: (
    table: AnyTable,
    v: SimplifyFindOptions<FindFirstOptions>,
  ) => Promise<Record<string, unknown> | null>;

  findMany: (
    table: AnyTable,
    v: SimplifyFindOptions<FindManyOptions>,
  ) => Promise<Record<string, unknown>[]>;

  updateMany: (
    table: AnyTable,
    v: {
      where?: Condition;
      set: Record<string, unknown>;
    },
  ) => Promise<void>;

  upsert: (
    table: AnyTable,
    v: {
      where: Condition | undefined;
      update: Record<string, unknown>;
      create: Record<string, unknown>;
    },
  ) => Promise<void>;

  create: (
    table: AnyTable,
    values: Record<string, unknown>,
  ) => Promise<Record<string, unknown>>;

  createMany: (
    table: AnyTable,
    values: Record<string, unknown>[],
  ) => Promise<
    {
      _id: unknown;
    }[]
  >;

  deleteMany: (
    table: AnyTable,
    v: {
      where?: Condition;
    },
  ) => Promise<void>;

  /**
   * Override this to support native transaction, otherwise use soft transaction.
   */
  transaction: <T>(
    run: (transactionInstance: AbstractQuery<S>) => Promise<T>,
  ) => Promise<T>;
}

export interface ToORMOptions {
  readonly context?: unknown;
}

export function toORM<S extends AnySchema>(
  adapter: ORMAdapter<S>,
  options: ToORMOptions = {},
): AbstractQuery<S> {
  const context = options.context ?? adapter.context;
  const internal: ORMAdapter<S> =
    context === adapter.context ? adapter : { ...adapter, context };

  function toTable<TableName extends keyof S["tables"]>(
    name: TableName,
  ): S["tables"][TableName] {
    const table = internal.tables[name];
    if (!table) throw new Error(`[FumaDB] Invalid table name ${String(name)}.`);

    return table;
  }

  const query = {
    internal,
    async count(name, { where } = {}) {
      const table = toTable(name);
      let conditions = where ? buildCondition(table.columns, where) : undefined;
      if (conditions === true) conditions = undefined;
      if (conditions === false) return 0;

      const constrainedWhere = await applyReadPolicies(table, conditions, context);
      if (constrainedWhere === false) return 0;
      return await internal.count(table, { where: constrainedWhere });
    },
    async upsert(name, { where, ...options }) {
      const table = toTable(name);
      const conditions = where ? buildCondition(table.columns, where) : undefined;
      if (conditions === false) return;
      let compiledWhere: Condition | undefined | false = conditions === true ? undefined : conditions;

      compiledWhere = await applyUpdatePolicies(
        table,
        compiledWhere,
        options.update,
        context,
        "upsert",
        options.create,
      );
      if (compiledWhere === false) return;
      await runCreatePolicies(table, options.create, context);
      await internal.upsert(table, {
        where: compiledWhere,
        ...options,
      });
    },
    async create(name, values) {
      const table = toTable(name);
      await runCreatePolicies(table, values, context);
      return await internal.create(table, values);
    },
    async createMany(name, values) {
      const table = toTable(name);
      for (const value of values) {
        await runCreatePolicies(table, value, context);
      }

      return await internal.createMany(table, values);
    },
    async deleteMany(name, { where }) {
      const table = toTable(name);
      let conditions = where ? buildCondition(table.columns, where) : undefined;
      if (conditions === true) conditions = undefined;
      if (conditions === false) return;

      const constrainedWhere = await applyDeletePolicies(table, conditions, context);
      if (constrainedWhere === false) return;
      await internal.deleteMany(table, { where: constrainedWhere });
    },
    async findMany(name, options = {}) {
      const table = toTable(name);
      let compiledOptions = buildFindOptions(table, options as FindManyOptions);
      if (compiledOptions === false) return [];

      compiledOptions = await applyReadPoliciesToOptions(table, compiledOptions, context);
      if (compiledOptions === false) return [];
      const records = await internal.findMany(table, compiledOptions);
      applyDeniedJoinDefaults(records, compiledOptions);
      return records;
    },
    async findFirst(name, options) {
      const table = toTable(name);
      let compiledOptions = buildFindOptions(table, options as FindFirstOptions);
      if (compiledOptions === false) return null;

      compiledOptions = await applyReadPoliciesToOptions(table, compiledOptions, context);
      if (compiledOptions === false) return null;
      const record = await internal.findFirst(table, compiledOptions);
      if (record) applyDeniedJoinDefaults([record], compiledOptions);
      return record;
    },
    async updateMany(name, { set, where }) {
      const table = toTable(name);
      let conditions = where ? buildCondition(table.columns, where) : undefined;
      if (conditions === true) conditions = undefined;
      if (conditions === false) return;

      const constrainedWhere = await applyUpdatePolicies(
        table,
        conditions,
        set,
        context,
        "update",
      );
      if (constrainedWhere === false) return;
      return internal.updateMany(table, { set, where: constrainedWhere });
    },
    async transaction(run) {
      return internal.transaction((transactionInstance) =>
        run(withQueryContext(transactionInstance, context)),
      );
    },
  } as AbstractQuery<S>;

  Object.defineProperty(query, "withContext", {
    enumerable: false,
    value(nextContext: unknown) {
      return toORM(internal, { context: nextContext });
    },
  });

  return query;
}

export function withQueryContext<S extends AnySchema, TContext>(
  db: AbstractQuery<S>,
  context: TContext,
): AbstractQuery<S> {
  if (typeof db.withContext === "function") return db.withContext(context);

  throw new Error(
    "[FumaDB] Cannot apply query context to this query object. If you wrap an AbstractQuery, forward withContext so table policies keep using the wrapper.",
  );
}
