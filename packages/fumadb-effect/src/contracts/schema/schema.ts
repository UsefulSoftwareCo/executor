import type { Effect } from "effect";
import type { MigrationError } from "../errors.ts";
import type { MigrationOperation } from "../migration-operation.ts";
import type { SqlError } from "effect/sql/SqlError";
import type { AnyColumn } from "./column.ts";
import {
  type AnyRelation,
  type AnyRelationInit,
  type ExplicitRelation,
  ExplicitRelationInit,
  type ForeignKey,
  type ImplicitRelation,
  ImplicitRelationInit,
  type RelationBuilder,
  relationBuilder,
  type RelationType,
} from "./relation.ts";
import type { AnyTable, Table } from "./table.ts";
import { validateSchema } from "./validate.ts";
import { SchemaDefinitionError } from "../errors.ts";

export interface MigrationContext {
  readonly auto: Effect.Effect<ReadonlyArray<MigrationOperation>, MigrationError | SqlError>;
}

export type CustomMigrationFn = (
  context: MigrationContext,
) => Effect.Effect<ReadonlyArray<MigrationOperation>, MigrationError | SqlError>;

export interface Schema<
  Version extends string = string,
  Tables extends Record<string, AnyTable> = Record<string, AnyTable>,
> {
  readonly version: Version;
  readonly tables: Tables;
  readonly up: CustomMigrationFn | undefined;
  readonly down: CustomMigrationFn | undefined;
  readonly clone: () => Schema<Version, Tables>;
}

export type AnySchema = Schema<string, Record<string, AnyTable>>;

export type RelationsMap<Tables extends Record<string, AnyTable>> = {
  readonly [K in keyof Tables]?: (
    builder: RelationBuilder<Tables, K>,
  ) => Record<string, AnyRelationInit<Tables>>;
};

type BuildRelation<Tables extends Record<string, AnyTable>, RM extends RelationsMap<Tables>, R> =
  R extends ExplicitRelationInit<infer Type, Tables, infer K>
    ? ExplicitRelation<Type, CreateSchemaTables<Tables, RM>[K]>
    : R extends ImplicitRelationInit<infer Type, Tables, infer K>
      ? ImplicitRelation<Type, CreateSchemaTables<Tables, RM>[K]>
      : never;

type Override<T, O> = Omit<T, keyof O> & O;

export type CreateSchemaTables<
  Tables extends Record<string, AnyTable>,
  RM extends RelationsMap<Tables>,
> = {
  [K in keyof Tables]: Tables[K] extends Table<infer Columns, infer Relations>
    ? Table<
        Columns,
        RM[K] extends (builder: RelationBuilder<Tables, K>) => infer Out
          ? Override<Relations, { [R in keyof Out]: BuildRelation<Tables, RM, Out[R]> }>
          : Relations
      >
    : never;
};

export interface SchemaConfig<
  Version extends string,
  Tables extends Record<string, AnyTable>,
  RM extends RelationsMap<Tables>,
> {
  readonly version: Version;
  readonly tables: Tables;
  readonly relations?: RM;
  readonly up?: CustomMigrationFn;
  readonly down?: CustomMigrationFn;
}

export const getTable = (schema: AnySchema, ormName: string): AnyTable => {
  const found = schema.tables[ormName];
  if (found === undefined)
    throw new SchemaDefinitionError(`Unknown table "${ormName}" in schema ${schema.version}.`);
  return found;
};

export const schema = <
  Version extends string,
  Tables extends Record<string, AnyTable>,
  RM extends RelationsMap<Tables>,
>(
  config: SchemaConfig<Version, Tables, RM>,
): Schema<Version, CreateSchemaTables<Tables, RM>> => {
  const { relations, tables: input } = config;
  const tables: Record<string, AnyTable> = {};
  for (const [key, value] of Object.entries(input)) {
    if (value === undefined) continue;
    const cloned = value.clone();
    cloned.ormName = key;
    tables[key] = cloned;
  }
  copyRelations(input, tables);
  if (relations !== undefined) setRelations(tables as unknown as Tables, relations);

  const out: Schema<Version, CreateSchemaTables<Tables, RM>> = {
    version: config.version,
    tables: tables as unknown as CreateSchemaTables<Tables, RM>,
    up: config.up,
    down: config.down,
    clone() {
      const clonedTables: Record<string, AnyTable> = {};
      for (const [key, value] of Object.entries(tables)) clonedTables[key] = value.clone();
      copyRelations(tables, clonedTables);
      const cloned = schema({
        version: config.version,
        tables: clonedTables,
        ...(config.up === undefined ? {} : { up: config.up }),
        ...(config.down === undefined ? {} : { down: config.down }),
      });
      return cloned as unknown as Schema<Version, CreateSchemaTables<Tables, RM>>;
    },
  };
  validateSchema(out);
  return out;
};

const copyRelations = (
  source: Record<string, AnyTable>,
  target: Record<string, AnyTable>,
  skip: ReadonlySet<string> = new Set(),
): void => {
  const copies = new Map<ExplicitRelation, ExplicitRelation>();
  const resolveTable = (table: AnyTable): AnyTable => target[table.ormName] ?? table;
  const resolveColumn = (col: AnyColumn): AnyColumn =>
    resolveTable(col.table).columns[col.ormName] ?? col;
  const copyForeignKey = (key: ForeignKey): ForeignKey => ({
    name: key.name,
    onUpdate: key.onUpdate,
    onDelete: key.onDelete,
    table: resolveTable(key.table),
    referencedTable: resolveTable(key.referencedTable),
    columns: key.columns.map(resolveColumn),
    referencedColumns: key.referencedColumns.map(resolveColumn),
  });

  const eachRelation = (fn: (relation: AnyRelation, clonedTable: AnyTable) => void): void => {
    for (const [key, table] of Object.entries(source)) {
      const clonedTable = target[key];
      if (clonedTable === undefined || skip.has(key)) continue;
      for (const relation of Object.values(table.relations)) fn(relation, clonedTable);
    }
  };

  eachRelation((relation, clonedTable) => {
    if (relation.implied) return;
    const copy: ExplicitRelation = {
      id: relation.id,
      implied: false,
      name: relation.name,
      type: relation.type,
      on: relation.on,
      referencer: resolveTable(relation.referencer),
      table: resolveTable(relation.table),
      implying: undefined,
      foreignKey:
        relation.foreignKey === undefined ? undefined : copyForeignKey(relation.foreignKey),
    };
    copies.set(relation, copy);
    (clonedTable.relations as Record<string, AnyRelation>)[relation.name] = copy;
    if (copy.foreignKey !== undefined) clonedTable.foreignKeys.push(copy.foreignKey);
  });

  eachRelation((relation, clonedTable) => {
    if (!relation.implied) return;
    const impliedBy = copies.get(relation.impliedBy);
    if (impliedBy === undefined) return;
    const copy: ImplicitRelation = {
      id: relation.id,
      implied: true,
      impliedBy,
      name: relation.name,
      type: relation.type,
      on: relation.on,
      referencer: resolveTable(relation.referencer),
      table: resolveTable(relation.table),
    };
    impliedBy.implying = copy;
    (clonedTable.relations as Record<string, AnyRelation>)[relation.name] = copy;
  });
};

const setRelations = <Tables extends Record<string, AnyTable>>(
  tables: Tables,
  relationsMap: RelationsMap<Tables>,
): void => {
  const implied: Array<{
    relationName: string;
    relation: ImplicitRelationInit<RelationType, Tables, keyof Tables>;
  }> = [];
  const explicit: Array<{ implicitRelationName: string | undefined; relation: ExplicitRelation }> =
    [];

  for (const key of Object.keys(relationsMap)) {
    const relationFn = relationsMap[key];
    const t = tables[key];
    if (relationFn === undefined || t === undefined) continue;
    const built = relationFn(relationBuilder(tables, key));
    for (const name of Object.keys(built)) {
      const relation = built[name];
      if (relation === undefined) continue;
      if (relation instanceof ImplicitRelationInit) {
        implied.push({ relationName: name, relation });
        continue;
      }
      if (relation instanceof ExplicitRelationInit) {
        for (const [left, right] of relation.on) {
          const referencing = t.columns[left];
          const referenced = relation.referencedTable.columns[right];
          if (referencing !== undefined && referenced !== undefined)
            referencing.adoptStorageType(referenced);
        }
        const output = relation.init(name);
        explicit.push({ relation: output, implicitRelationName: relation.implyingRelationName });
        const previous = (t.relations as Record<string, AnyRelation>)[name];
        if (previous !== undefined && !previous.implied && previous.foreignKey !== undefined) {
          const at = t.foreignKeys.indexOf(previous.foreignKey);
          if (at !== -1) t.foreignKeys.splice(at, 1);
        }
        (t.relations as Record<string, ExplicitRelation>)[name] = output;
        if (output.foreignKey !== undefined) t.foreignKeys.push(output.foreignKey);
      }
    }
  }

  for (const { relation, relationName } of implied) {
    const referencer = relation.referencer;
    const candidates = explicit.filter((item) => {
      if (item.implicitRelationName !== undefined)
        return item.implicitRelationName === relationName;
      return (
        item.relation.table === referencer && item.relation.referencer === relation.referencedTable
      );
    });
    const single = candidates[0];
    if (candidates.length !== 1 || single === undefined) {
      throw new SchemaDefinitionError(
        `Cannot resolve implied relation ${relationName} in table "${referencer.ormName}", you may want to specify \`imply()\` on the explicit relation.`,
      );
    }
    (referencer.relations as Record<string, ImplicitRelation>)[relationName] = relation.init(
      relationName,
      single.relation,
    );
  }
};

type OverrideTables<
  Tables extends Record<string, AnyTable>,
  O extends Record<string, AnyTable | boolean>,
> = Omit<Tables, keyof O> & {
  [K in keyof O as O[K] extends AnyTable | true ? K : never]: O[K] extends true
    ? K extends keyof Tables
      ? Tables[K]
      : never
    : O[K];
};

export const variantSchema = <
  Variant extends string,
  Version extends string,
  Tables extends Record<string, AnyTable>,
  $Tables extends Record<string, AnyTable>,
  RM extends RelationsMap<OverrideTables<Tables, $Tables>>,
>(
  variant: Variant,
  original: Schema<Version, Tables>,
  override: { readonly tables: $Tables; readonly relations?: RM },
): Schema<`${Version}-${Variant}`, CreateSchemaTables<OverrideTables<Tables, $Tables>, RM>> => {
  const tables: Record<string, AnyTable> = {};
  for (const [key, value] of Object.entries(original.tables)) tables[key] = value.clone();
  const replaced = new Set<string>();
  for (const [key, value] of Object.entries(override.tables)) {
    if (value === undefined) continue;
    const cloned = value.clone();
    cloned.ormName = key;
    tables[key] = cloned;
    replaced.add(key);
  }
  copyRelations(original.tables, tables, replaced);
  return schema({
    version: `${original.version}-${variant}` as const,
    tables: tables as OverrideTables<Tables, $Tables>,
    ...(override.relations === undefined ? {} : { relations: override.relations }),
  });
};
