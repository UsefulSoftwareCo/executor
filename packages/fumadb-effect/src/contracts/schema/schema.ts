/**
 * Schema definitions: a versioned set of tables and relations.
 */
import type { Effect } from "effect";
import type { MigrationError } from "../errors.ts";
import type { MigrationOperation } from "../migration-operation.ts";
import type { SqlError } from "effect/unstable/sql/SqlError";
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

/** Context passed to custom `up` / `down` migration functions. */
export interface MigrationContext {
  /** The automatically generated operations for this step. */
  readonly auto: Effect.Effect<ReadonlyArray<MigrationOperation>, MigrationError | SqlError>;
}

/** A custom migration step. Return the operations to run, usually derived from `context.auto`. */
export type CustomMigrationFn = (
  context: MigrationContext,
) => Effect.Effect<ReadonlyArray<MigrationOperation>, MigrationError | SqlError>;

/** One version of a library's schema. Construct with {@link schema} or {@link variantSchema}. */
export interface Schema<
  Version extends string = string,
  Tables extends Record<string, AnyTable> = Record<string, AnyTable>,
> {
  /** A semantic version. The prerelease part names a variant. */
  readonly version: Version;
  readonly tables: Tables;
  readonly up: CustomMigrationFn | undefined;
  readonly down: CustomMigrationFn | undefined;
  readonly clone: () => Schema<Version, Tables>;
}

/** Any schema, regardless of its version and table types. */
export type AnySchema = Schema<string, Record<string, AnyTable>>;

/** Relation callbacks keyed by the ORM name of the table that declares them. */
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

/** The table types of a schema, with the relations of `RM` attached to each table. */
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

/** The definition passed to {@link schema}. */
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

/** Look a table up by ORM name, raising a defect when it is missing. Use only for names the schema validated. */
export const getTable = (schema: AnySchema, ormName: string): AnyTable => {
  const found = schema.tables[ormName];
  if (found === undefined)
    throw new SchemaDefinitionError(`Unknown table "${ormName}" in schema ${schema.version}.`);
  return found;
};

/**
 * Define a schema version.
 *
 * Tables are keyed by ORM name. Relations are declared per table with a
 * builder. The schema is validated on construction and a
 * `SchemaDefinitionError` is thrown for invalid definitions.
 *
 * The tables passed in are never modified: each one is cloned first, so the
 * same `table()` object can be given to several schema versions.
 */
export const schema = <
  Version extends string,
  Tables extends Record<string, AnyTable>,
  RM extends RelationsMap<Tables>,
>(
  config: SchemaConfig<Version, Tables, RM>,
): Schema<Version, CreateSchemaTables<Tables, RM>> => {
  const { relations, tables: input } = config;
  // Every table is cloned before anything is written to it. Relations attach a
  // foreign key to the table they are declared on, so sharing one `table()`
  // object across schema versions would otherwise append the same key twice
  // and overwrite the earlier version's relation map.
  const tables: Record<string, AnyTable> = {};
  for (const [key, value] of Object.entries(input)) {
    if (value === undefined) continue;
    const cloned = value.clone();
    cloned.ormName = key;
    tables[key] = cloned;
  }
  // An input table may already carry relations, from `clone()` or from a
  // previous schema version. Recreate them on the copies.
  copyRelations(input, tables);
  // The copies stand in for the input tables, key for key.
  if (relations !== undefined) setRelations(tables as unknown as Tables, relations);

  const out: Schema<Version, CreateSchemaTables<Tables, RM>> = {
    version: config.version,
    tables: tables as unknown as CreateSchemaTables<Tables, RM>,
    up: config.up,
    down: config.down,
    clone() {
      const clonedTables: Record<string, AnyTable> = {};
      for (const [key, value] of Object.entries(tables)) clonedTables[key] = value.clone();
      // Relations are copied from the live tables, not rebuilt from
      // `config.relations`: a variant schema carries relations that its own
      // config does not describe.
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

/**
 * Recreate every relation and foreign key of `source` on the tables in
 * `target`, matched by ORM name, so the copies reference the tables and
 * columns of `target`.
 *
 * `skip` lists the ORM names whose own relations must not be copied, which is
 * how a variant drops the relations of a table it replaced. An implicit
 * relation is dropped as well when the explicit relation that implies it was
 * skipped, because the pair no longer exists.
 */
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
        // A referencing column stored as inferred text takes the referenced key's width.
        for (const [left, right] of relation.on) {
          const referencing = t.columns[left];
          const referenced = relation.referencedTable.columns[right];
          if (referencing !== undefined && referenced !== undefined)
            referencing.adoptStorageType(referenced);
        }
        const output = relation.init(name);
        explicit.push({ relation: output, implicitRelationName: relation.implyingRelationName });
        // A redeclared relation replaces the inherited one, foreign key
        // included; appending both would emit the constraint twice.
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

/**
 * Extend a schema into a variant, available as `<version>-<variant>`.
 *
 * 1. Tables and relations can be added and replaced.
 * 2. Tables cannot be removed; original relations may depend on them.
 * 3. Replacing a table removes the relations declared *on* it, and the
 *    implicit relations on other tables that those relations implied.
 * 4. A relation on another table that *targets* a replaced table is kept and
 *    re-pointed at the replacement, so no foreign key can reference a table
 *    that left the schema. The replacement must keep the referenced columns,
 *    or construction fails with a `SchemaDefinitionError`.
 *
 * Neither the original schema nor the replacement tables are modified.
 */
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
    // Cloned like the inherited tables: `copyRelations` below attaches foreign
    // keys, and the caller's `table()` object must stay reusable.
    const cloned = value.clone();
    cloned.ormName = key;
    tables[key] = cloned;
    replaced.add(key);
  }
  // Copy the inherited relations onto the final tables, so a relation that
  // targeted a replaced table now points at the replacement instead of at the
  // clone that was thrown away.
  copyRelations(original.tables, tables, replaced);
  return schema({
    version: `${original.version}-${variant}` as const,
    tables: tables as OverrideTables<Tables, $Tables>,
    ...(override.relations === undefined ? {} : { relations: override.relations }),
  });
};
