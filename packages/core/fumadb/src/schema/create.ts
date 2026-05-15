import { createId } from "../cuid";
import type { CustomMigrationFn } from "../migration-engine/create";
import type { Condition, ConditionBuilder } from "../query/condition-builder";
import { validateSchema } from "./validate";

export type AnySchema = Schema<string, Record<string, AnyTable>>;

export type AnyRelation = Relation;

export interface AnyTable {
  names: NameVariants;
  ormName: string;
  columns: Record<string, AnyColumn>;
  relations: Record<string, AnyRelation>;
  foreignKeys: ForeignKey[];
  policies: StoredTablePolicy[];
  getUniqueConstraints: (level?: "table" | "column" | "all") => UniqueConstraint[];
  getColumnByName: (name: string, type?: keyof NameVariants) => AnyColumn | undefined;
  getIdColumn: () => AnyColumn;
  clone: () => AnyTable;
}

export type AnyColumn =
  | Column<keyof TypeMap, unknown, unknown>
  | IdColumn<IdColumnType, unknown, unknown>;

export type TableColumnName<T extends AnyTable> = Extract<keyof T["columns"], string>;

export type TableColumnValues<T extends AnyTable> = {
  [K in keyof T["columns"]]: T["columns"][K]["$out"];
};

type Simplify<T> = {
  [K in keyof T]: T[K];
};

type TableColumnInputValues<T extends AnyTable> = {
  [K in keyof T["columns"]]: T["columns"][K]["$in"];
};

type PickNotNullable<T> = {
  [P in keyof T as null extends T[P] ? never : P]: T[P];
};

export type TableInsertValues<T extends AnyTable> = Simplify<
  {
    [K in keyof T["columns"]]?: T["columns"][K]["$in"];
  } & PickNotNullable<TableColumnInputValues<T>>
>;

export type TableUpdateValues<T extends AnyTable> = {
  [K in keyof T["columns"]]?: T["columns"][K] extends IdColumn
    ? never
    : T["columns"][K]["$in"];
};

type MaybePromise<T> = T | Promise<T>;
export type TablePolicyCondition = Condition | boolean | void;

export interface TableReadPolicyInput<TTable extends AnyTable, TContext> {
  readonly where: Condition | undefined;
  readonly context: TContext;
  readonly builder: ConditionBuilder<TTable["columns"]>;
}

export interface TableCreatePolicyInput<TTable extends AnyTable, TContext> {
  readonly values: TableInsertValues<TTable>;
  readonly context: TContext;
}

export interface TableUpdatePolicyInput<TTable extends AnyTable, TContext> {
  readonly where: Condition | undefined;
  readonly set: TableUpdateValues<TTable>;
  readonly create?: TableInsertValues<TTable>;
  readonly context: TContext;
  readonly builder: ConditionBuilder<TTable["columns"]>;
  readonly operation: "update" | "upsert";
}

export interface TableDeletePolicyInput<TTable extends AnyTable, TContext> {
  readonly where: Condition | undefined;
  readonly context: TContext;
  readonly builder: ConditionBuilder<TTable["columns"]>;
}

export type TableReadPolicyCallback<TTable extends AnyTable, TContext> = (
  input: TableReadPolicyInput<TTable, TContext>
) => MaybePromise<TablePolicyCondition>;

export type TableCreatePolicyCallback<TTable extends AnyTable, TContext> = (
  input: TableCreatePolicyInput<TTable, TContext>
) => MaybePromise<void>;

export type TableUpdatePolicyCallback<TTable extends AnyTable, TContext> = (
  input: TableUpdatePolicyInput<TTable, TContext>
) => MaybePromise<TablePolicyCondition>;

export type TableDeletePolicyCallback<TTable extends AnyTable, TContext> = (
  input: TableDeletePolicyInput<TTable, TContext>
) => MaybePromise<TablePolicyCondition>;

export interface TablePolicy<
  TTable extends AnyTable = AnyTable,
  TContext = unknown,
> {
  readonly name?: string;
  onRead?: TableReadPolicyCallback<TTable, TContext>;
  onCreate?: TableCreatePolicyCallback<TTable, TContext>;
  onUpdate?: TableUpdatePolicyCallback<TTable, TContext>;
  onDelete?: TableDeletePolicyCallback<TTable, TContext>;
}

export interface StoredTablePolicy {
  readonly name?: string;
  onRead?: TableReadPolicyCallback<AnyTable, unknown>;
  onCreate?: TableCreatePolicyCallback<AnyTable, unknown>;
  onUpdate?: TableUpdatePolicyCallback<AnyTable, unknown>;
  onDelete?: TableDeletePolicyCallback<AnyTable, unknown>;
}

export type ForeignKeyAction = "RESTRICT" | "CASCADE" | "SET NULL";

export interface NameVariants {
  sql: string;
  drizzle: string;
  prisma: string;
  convex: string;
  mongodb: string;
}

export interface ForeignKey {
  name: string;
  table: AnyTable;
  columns: AnyColumn[];

  referencedTable: AnyTable;
  referencedColumns: AnyColumn[];
  onUpdate: ForeignKeyAction;
  onDelete: ForeignKeyAction;
}

class RelationInit<
  Type extends RelationType,
  Tables extends Record<string, AnyTable>,
  T extends keyof Tables,
> {
  type: Type;
  referencedTable: Tables[T];
  referencer: AnyTable;

  constructor(type: Type, referencedTable: Tables[T], referencer: AnyTable) {
    this.type = type;
    this.referencedTable = referencedTable;
    this.referencer = referencer;
  }
}

export class ImplicitRelationInit<
  Type extends RelationType,
  Tables extends Record<string, AnyTable>,
  T extends keyof Tables,
> extends RelationInit<Type, Tables, T> {
  init(ormName: string, impliedBy: ExplicitRelation) {
    const output: ImplicitRelation<Type, Tables[T]> = {
      id: impliedBy.id,
      on: impliedBy.on.map(([left, right]) => [right, left]),
      type: this.type,
      table: this.referencedTable,
      implied: true,
      impliedBy,
      name: ormName,
      referencer: this.referencer,
    };

    impliedBy.implying = output;
    return output;
  }
}

export interface UniqueConstraint {
  name: string;
  columns: AnyColumn[];
}

interface ForeignKeyConfig {
  name: string;
  onUpdate: ForeignKeyAction;
  onDelete: ForeignKeyAction;
}

export class ExplicitRelationInit<
  Type extends RelationType,
  Tables extends Record<string, AnyTable>,
  T extends keyof Tables,
> extends RelationInit<Type, Tables, T> {
  private foreignKeyConfig?: Partial<ForeignKeyConfig>;
  implyingRelationName?: string;
  on: [string, string][] = [];

  imply(implyingRelationName: string) {
    this.implyingRelationName = implyingRelationName;
    return this;
  }

  private initForeignKey(ormName: string): ForeignKey | undefined {
    const config = this.foreignKeyConfig;
    if (!config) return;

    const columns: AnyColumn[] = [];
    const referencedColumns: AnyColumn[] = [];

    for (const [left, right] of this.on) {
      columns.push(this.referencer.columns[left]);
      referencedColumns.push(this.referencedTable.columns[right]);
    }

    return {
      columns,
      referencedColumns,
      referencedTable: this.referencedTable,
      table: this.referencer,
      name:
        config.name ??
        `${this.referencer.ormName}_${this.referencedTable.ormName}_${ormName}_fk`,
      onDelete: config.onDelete ?? "RESTRICT",
      onUpdate: config.onUpdate ?? "RESTRICT",
    };
  }

  init(ormName: string): ExplicitRelation<Type, Tables[T]> {
    let id = `${this.referencer.ormName}_${this.referencedTable.ormName}`;
    if (this.implyingRelationName) id += `_${this.implyingRelationName}`;

    return {
      id,
      implied: false,
      foreignKey: this.initForeignKey(ormName),
      implying: undefined,
      on: this.on,
      name: ormName,
      referencer: this.referencer,
      table: this.referencedTable,
      type: this.type,
    };
  }

  /**
   * Define foreign key for explicit relation, please note that:
   *
   * - this constraint is ignored for MongoDB (without Prisma).
   * - you **must** define foreign key for explicit relations, due to the limitations of Prisma.
   */
  foreignKey(config: Partial<ForeignKeyConfig> = {}) {
    this.foreignKeyConfig = config;
    return this;
  }
}

interface BaseRelation<
  Type extends RelationType = RelationType,
  T extends AnyTable = AnyTable,
> {
  /**
   * The relation id shared between implied/implying relation
   */
  id: string;
  name: string;
  type: Type;

  table: T;
  referencer: AnyTable;

  on: [string, string][];
}

export interface ImplicitRelation<
  Type extends RelationType = RelationType,
  T extends AnyTable = AnyTable,
> extends BaseRelation<Type, T> {
  implied: true;
  readonly impliedBy: ExplicitRelation;
}

export interface ExplicitRelation<
  Type extends RelationType = RelationType,
  T extends AnyTable = AnyTable,
> extends BaseRelation<Type, T> {
  implied: false;
  implying: ImplicitRelation | undefined;
  foreignKey?: ForeignKey;
}

export type Relation<
  Type extends RelationType = RelationType,
  T extends AnyTable = AnyTable,
> = ImplicitRelation<Type, T> | ExplicitRelation<Type, T>;

export interface Table<
  Columns extends Record<string, AnyColumn> = Record<string, AnyColumn>,
  Relations extends Record<string, AnyRelation> = Record<string, AnyRelation>,
> {
  names: NameVariants;
  ormName: string;

  columns: Columns;
  relations: Relations;
  foreignKeys: ForeignKey[];
  policies: StoredTablePolicy[];

  /**
   * @param level default to 'all'
   */
  getUniqueConstraints: (
    level?: "table" | "column" | "all"
  ) => UniqueConstraint[];

  /**
   * @param name - name
   * @param type - default to "sql"
   */
  getColumnByName: (
    name: string,
    type?: keyof NameVariants
  ) => AnyColumn | undefined;
  getIdColumn: () => AnyColumn;

  /**
   * Add unique constraint to the fields, for consistency, duplicated null values are allowed.
   */
  unique(name: string, columns: (keyof Columns)[]): Table<Columns, Relations>;

  policy<TContext>(policy: TablePolicy<this, TContext>): this;

  clone: () => Table<Columns, Relations>;
}

type DefaultFunctionMap = {
  date: "now";
  timestamp: "now";
  string: "auto";
} & Record<`varchar(${number})`, "auto">;

type DefaultFunction<Type extends keyof TypeMap> =
  | (Type extends keyof DefaultFunctionMap ? DefaultFunctionMap[Type] : never)
  | (() => TypeMap[Type]);

type IdColumnType = `varchar(${number})` | "uuid";

export type TypeMap = {
  string: string;
  bigint: bigint;
  integer: number;
  decimal: number;
  bool: boolean;
  json: unknown;
  /**
   * this follows the same specs as Prisma `Bytes` for consistency.
   */
  binary: Uint8Array;
  date: Date;
  timestamp: Date;
  uuid: string;
} & Record<`varchar(${number})`, string>;

export class Column<Type extends keyof TypeMap, In = unknown, Out = unknown> {
  type: Type;
  ormName: string = "";
  isNullable: boolean = false;
  isUnique: boolean = false;
  default?:
    | { value: TypeMap[Type] }
    | {
        runtime: DefaultFunction<Type>;
      };

  table: AnyTable = undefined as unknown as AnyTable;

  private initNames: (ormName: string) => NameVariants;

  get names(): NameVariants {
    return this.initNames(this.ormName);
  }

  set names(v: NameVariants) {
    this.initNames = () => v;
  }

  constructor(type: Type, onInitNames: (ormName: string) => NameVariants) {
    this.type = type;
    this.initNames = onInitNames;
  }

  nullable<T extends boolean = true>(nullable?: T) {
    this.isNullable = nullable ?? true;

    return this as Column<
      Type,
      T extends true ? In | null : Exclude<In, null>,
      T extends true ? Out | null : Exclude<Out, null>
    >;
  }

  /**
   * Add unique constraint to the field, for consistency, duplicated null values are allowed.
   */
  unique(unique: boolean = true) {
    this.isUnique = unique;
    return this;
  }

  /**
   * Generate default value on runtime
   */
  defaultTo$(fn: DefaultFunction<Type>): Column<Type, In | null, Out> {
    this.default = { runtime: fn };
    return this;
  }

  /**
   * Set a database-level default value
   *
   * For schemaless database, it's still generated on runtime
   */
  defaultTo(value: TypeMap[Type]): Column<Type, In | null, Out> {
    this.default = { value };
    return this;
  }

  clone() {
    const clone = new Column(this.type, () => this.names);
    clone.ormName = this.ormName;
    clone.isNullable = this.isNullable;
    clone.isUnique = this.isUnique;
    clone.default = this.default;
    clone.table = this.table;
    return clone;
  }

  getUniqueConstraintName(): string {
    return `unique_c_${this.table.ormName}_${this.ormName}`;
  }

  /**
   * Generate default value for the column on runtime.
   */
  generateDefaultValue(): TypeMap[Type] | undefined {
    if (!this.default) return;

    if ("value" in this.default) return this.default.value;
    if (this.default.runtime === "auto") return createId() as TypeMap[Type];
    if (this.default.runtime === "now")
      return new Date(Date.now()) as TypeMap[Type];

    return this.default.runtime();
  }

  get $in(): In {
    throw new Error("Type inference only");
  }
  get $out(): Out {
    throw new Error("Type inference only");
  }
}

export class IdColumn<
  Type extends IdColumnType = IdColumnType,
  In = unknown,
  Out = unknown,
> extends Column<Type, In, Out> {
  id = true;

  constructor(type: Type, onInitNames: (ormName: string) => NameVariants) {
    super(type, (ormName) => ({
      ...onInitNames(ormName),
      mongodb: "_id",
    }));
  }

  override clone() {
    const clone = new IdColumn(this.type, () => this.names);
    clone.ormName = this.ormName;
    clone.isNullable = this.isNullable;
    clone.isUnique = this.isUnique;
    clone.default = this.default;
    clone.table = this.table;
    return clone;
  }

  override defaultTo$(fn: DefaultFunction<Type>) {
    return super.defaultTo$(fn) as IdColumn<Type, In | null, Out>;
  }

  override defaultTo(value: TypeMap[Type]) {
    return super.defaultTo(value) as IdColumn<Type, In | null, Out>;
  }
}

export function column<Type extends keyof TypeMap>(
  name: string | Partial<NameVariants>,
  type: Type
): Column<Type, TypeMap[Type], TypeMap[Type]> {
  return new Column(type, (ormName) =>
    typeof name === "string"
      ? nameVariants(name, ormName)
      : nameVariants(ormName, ormName, name)
  );
}

export function idColumn<Type extends IdColumnType>(
  name: string | Partial<NameVariants>,
  type: Type
): IdColumn<Type, TypeMap[Type], TypeMap[Type]> {
  return new IdColumn(type, (ormName) =>
    typeof name === "string"
      ? nameVariants(name, ormName)
      : nameVariants(ormName, ormName, name)
  );
}

export type RelationType = "many" | "one";

export interface RelationBuilder<
  Tables extends Record<string, AnyTable> = Record<string, AnyTable>,
  K extends keyof Tables = keyof Tables,
> {
  one<T extends keyof Tables>(
    another: T
  ): ImplicitRelationInit<"one", Tables, T>;

  one<T extends keyof Tables>(
    another: T,
    ...on: [keyof Tables[K]["columns"], keyof Tables[T]["columns"]][]
  ): ExplicitRelationInit<"one", Tables, T>;

  many<T extends keyof Tables>(
    another: T
  ): ImplicitRelationInit<"many", Tables, T>;
}

function relationBuilder<
  Tables extends Record<string, AnyTable>,
  K extends keyof Tables,
>(tables: Tables, k: K): RelationBuilder<Tables, K> {
  const referencer = tables[k];

  return {
    one(another, ...on) {
      if (on.length > 0) {
        const init = new ExplicitRelationInit(
          "one",
          tables[another],
          referencer
        );
        init.on = on as [string, string][];
        return init;
      }

      return new ImplicitRelationInit(
        "one",
        tables[another],
        referencer
      ) as any;
    },
    many(another) {
      return new ImplicitRelationInit("many", tables[another], referencer);
    },
  };
}

export function table<Columns extends Record<string, AnyColumn>>(
  name: string | Partial<NameVariants>,
  columns: Columns
): Table<Columns, {}> {
  let idCol: AnyColumn | undefined;
  let names: NameVariants | undefined;

  const uniqueConstraints: UniqueConstraint[] = [];
  const policies: StoredTablePolicy[] = [];
  const out: Table<Columns, {}> = {
    ormName: "",
    get names() {
      if (names) return names;

      return typeof name === "string"
        ? nameVariants(name, out.ormName)
        : nameVariants(out.ormName, out.ormName, name);
    },
    set names(v) {
      names = v;
    },
    columns,
    relations: {},
    foreignKeys: [],
    policies,
    getUniqueConstraints(level = "all") {
      const result: UniqueConstraint[] = [];
      if (level === "all" || level === "table")
        result.push(...uniqueConstraints);

      if (level === "all" || level === "column") {
        for (const col of Object.values(this.columns)) {
          if (!col.isUnique) continue;

          result.push({
            name: col.getUniqueConstraintName(),
            columns: [col],
          });
        }
      }

      return result;
    },
    getColumnByName(name, type = "sql") {
      return Object.values(this.columns).find((c) => c.names[type] === name);
    },
    getIdColumn() {
      return idCol!;
    },
    unique(name, columns) {
      uniqueConstraints.push({
        name,
        columns: columns.map((name) => {
          const column = this.columns[name];
          if (!column)
            throw new Error(`Unknown column name ${name.toString()}`);

          return column;
        }),
      });

      return this;
    },
    policy(policy) {
      policies.push(policy as StoredTablePolicy);
      return this;
    },
    clone() {
      const cloneColumns: Record<string, AnyColumn> = {};

      for (const [k, v] of Object.entries(columns)) {
        cloneColumns[k] = v.clone();
      }

      const clone = table(name, cloneColumns as Columns);
      for (const con of uniqueConstraints) {
        clone.unique(
          con.name,
          con.columns.map((col) => col.ormName)
        );
      }
      clone.policies.push(...policies);

      return clone;
    },
  };

  for (const k in columns) {
    const column = columns[k];
    if (!column) {
      delete columns[k];
      continue;
    }

    column.table = out;
    column.ormName = k;
    if (column instanceof IdColumn) idCol = column;
  }

  if (idCol === undefined) {
    throw new Error(`there's no id column in your table ${name}`);
  }

  return out;
}

type BuildRelation<
  Tables extends Record<string, AnyTable>,
  RM extends RelationsMap<Tables>,
  R,
> =
  R extends ExplicitRelationInit<infer Type, Tables, infer K>
    ? ExplicitRelation<Type, CreateSchemaTables<Tables, RM>[K]>
    : R extends ImplicitRelationInit<infer Type, Tables, infer K>
      ? ImplicitRelation<Type, CreateSchemaTables<Tables, RM>[K]>
      : never;

type Override<T, O> = Omit<T, keyof O> & O;
export type RelationsMap<Tables extends Record<string, AnyTable>> = {
  [K in keyof Tables]?: (
    builder: RelationBuilder<Tables, K>
  ) => Record<string, RelationInit<RelationType, Tables, keyof Tables>>;
};

type CreateSchemaTables<
  Tables extends Record<string, AnyTable>,
  RM extends RelationsMap<Tables>,
> = {
  [K in keyof Tables]: Tables[K] extends Table<infer Columns, infer Relations>
    ? Table<
        Columns,
        RM[K] extends (builder: RelationBuilder<Tables, K>) => infer Out
          ? Override<
              Relations,
              {
                [R in keyof Out]: BuildRelation<Tables, RM, Out[R]>;
              }
            >
          : Relations
      >
    : Tables[K];
};

export interface Schema<
  Version extends string = string,
  Tables extends Record<string, AnyTable> = Record<string, AnyTable>,
> {
  /**
   * @description The version of the schema, it should be a semantic version string.
   */
  version: Version;
  tables: Tables;

  up?: CustomMigrationFn;
  down?: CustomMigrationFn;
  clone: () => Schema<Version, Tables>;
}

export function schema<
  Version extends string,
  Tables extends Record<string, AnyTable>,
  RM extends RelationsMap<Tables>,
>(config: {
  version: Version;
  tables: Tables;

  up?: CustomMigrationFn;
  down?: CustomMigrationFn;
  relations?: RM;
}): Schema<Version, CreateSchemaTables<Tables, RM>> {
  const { tables, relations } = config;

  for (const k in tables) {
    if (!tables[k]) {
      delete tables[k];
      continue;
    }

    tables[k].ormName = k;
  }

  if (relations) setRelations(tables, relations);
  const out: Schema<Version, CreateSchemaTables<Tables, RM>> = {
    ...config,
    tables: config.tables as unknown as CreateSchemaTables<Tables, RM>,
    clone() {
      const cloneTables: Record<string, AnyTable> = {};

      for (const [k, v] of Object.entries(tables)) {
        cloneTables[k] = v.clone();
      }

      return schema({
        ...config,
        tables: cloneTables as Tables,
      });
    },
  };

  validateSchema(out);
  return out;
}

function setRelations<Tables extends Record<string, AnyTable>>(
  tables: Tables,
  relationsMap: RelationsMap<Tables>
) {
  const impliedRelations: {
    relationName: string;
    relation: ImplicitRelationInit<RelationType, Tables, keyof Tables>;
  }[] = [];
  const explicitRelations: {
    implicitRelationName?: string;
    relation: ExplicitRelation;
  }[] = [];

  for (const k in relationsMap) {
    const relationFn = relationsMap[k];
    if (!relationFn) continue;
    const table = tables[k];

    const relations = relationFn(relationBuilder(tables, k));
    for (const name in relations) {
      const relation = relations[name];
      if (!relation) continue;

      if (relation instanceof ImplicitRelationInit) {
        impliedRelations.push({
          relationName: name,
          relation,
        });
        continue;
      }

      if (relation instanceof ExplicitRelationInit) {
        const output = relation.init(name);

        explicitRelations.push({
          relation: output,
          implicitRelationName: relation.implyingRelationName,
        });

        table.relations[name] = output;
        if (output.foreignKey) table.foreignKeys.push(output.foreignKey);
      }
    }
  }

  for (const { relation, relationName } of impliedRelations) {
    const referencer = relation.referencer;
    const explicits = explicitRelations.filter((item) => {
      if (item.implicitRelationName) {
        return item.implicitRelationName === relationName;
      }

      return (
        item.relation.table === referencer &&
        item.relation.referencer === relation.referencedTable
      );
    });

    if (explicits.length !== 1)
      throw new Error(
        `Cannot resolve implied relation ${relationName} in table "${relation.referencer.ormName}", you may want to specify \`imply()\` on the explicit relation.`
      );

    referencer.relations[relationName] = relation.init(
      relationName,
      explicits[0].relation
    );
  }
}

type OverrideTables<
  Tables extends Record<string, AnyTable>,
  Override extends Record<string, AnyTable | boolean>,
> = Omit<Tables, keyof Override> & {
  [K in keyof Override as Override[K] extends AnyTable | true
    ? K
    : never]: Override[K] extends true
    ? K extends keyof Tables
      ? Tables[K]
      : never
    : Override[K];
};

/**
 * extend original schema.
 *
 * 1. you can adding new tables and relations.
 * 2. you can replace relations.
 * 3. you cannot remove tables, otherwise it may breaks original relations.
 * 4. when replacing tables, its original relations will be removed.
 */
export function variantSchema<
  Variant extends string,
  Version extends string,
  Tables extends Record<string, AnyTable>,
  $Tables extends Record<string, AnyTable>,
  RM extends RelationsMap<OverrideTables<Tables, $Tables>>,
>(
  variant: Variant,
  originalSchema: Schema<Version, Tables>,
  override: {
    tables: $Tables;
    relations?: RM;
  }
): Schema<
  `${Version}-${Variant}`,
  CreateSchemaTables<OverrideTables<Tables, $Tables>, RM>
> {
  const cloned = originalSchema.clone();
  const tables = cloned.tables as Record<string, AnyTable>;

  for (const [k, v] of Object.entries(override.tables)) {
    if (v == null) continue;
    tables[k] = v;
  }

  if (override.relations)
    setRelations(tables as OverrideTables<Tables, $Tables>, override.relations);

  // TODO: support custom `up` and `down` for variant schema
  // TODO: support disabling relations
  return schema({
    version: `${originalSchema.version}-${variant}`,
    tables: tables as OverrideTables<Tables, $Tables>,
    relations: override.relations,
  });
}

function nameVariants(
  rawName: string,
  ormName: string,
  names?: Partial<NameVariants>
): NameVariants {
  return {
    convex: ormName,
    drizzle: ormName,
    prisma: ormName,
    mongodb: rawName,
    sql: rawName,
    ...names,
  };
}

export function compileForeignKey(key: ForeignKey, name: keyof NameVariants) {
  return {
    name: key.name,
    onUpdate: key.onUpdate,
    onDelete: key.onDelete,
    table: key.table.names[name],
    referencedTable: key.referencedTable.names[name],
    referencedColumns: key.referencedColumns.map((col) => col.names[name]),
    columns: key.columns.map((col) => col.names[name]),
  };
}
