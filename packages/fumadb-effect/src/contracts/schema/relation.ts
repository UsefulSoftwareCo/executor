/**
 * Relations between tables.
 *
 * An *explicit* relation names the columns that join two tables and owns a
 * foreign key. An *implicit* relation is declared on the referenced table and
 * is resolved against exactly one explicit relation pointing back at it.
 */
import { SchemaDefinitionError } from "../errors.ts";
import type { AnyColumn } from "./column.ts";
import type { AnyTable } from "./table.ts";

/** What the database does to the referencing rows when the referenced row changes or is removed. */
export type ForeignKeyAction = "RESTRICT" | "CASCADE" | "SET NULL";

/** Whether a relation yields one row or many. */
export type RelationType = "many" | "one";

/** A foreign key, with its columns resolved to column objects. */
export interface ForeignKey {
  readonly name: string;
  readonly table: AnyTable;
  readonly columns: ReadonlyArray<AnyColumn>;
  readonly referencedTable: AnyTable;
  readonly referencedColumns: ReadonlyArray<AnyColumn>;
  readonly onUpdate: ForeignKeyAction;
  readonly onDelete: ForeignKeyAction;
}

/** Options of `foreignKey()`. Both actions default to `RESTRICT`. */
export interface ForeignKeyConfig {
  readonly name: string;
  readonly onUpdate: ForeignKeyAction;
  readonly onDelete: ForeignKeyAction;
}

interface BaseRelation<Type extends RelationType, T extends AnyTable> {
  /** Shared between an explicit relation and the implicit relation it implies. */
  readonly id: string;
  readonly name: string;
  readonly type: Type;
  /** The target table. */
  readonly table: T;
  /** The table that declares the relation. */
  readonly referencer: AnyTable;
  /** Pairs of `[referencer column, target column]` ORM names. */
  readonly on: ReadonlyArray<readonly [string, string]>;
}

/** A relation declared on the referenced table, resolved from the explicit relation that implies it. */
export interface ImplicitRelation<
  Type extends RelationType = RelationType,
  T extends AnyTable = AnyTable,
> extends BaseRelation<Type, T> {
  readonly implied: true;
  readonly impliedBy: ExplicitRelation;
}

/** A relation that names its join columns and owns the foreign key. */
export interface ExplicitRelation<
  Type extends RelationType = RelationType,
  T extends AnyTable = AnyTable,
> extends BaseRelation<Type, T> {
  readonly implied: false;
  implying: ImplicitRelation | undefined;
  readonly foreignKey: ForeignKey | undefined;
}

/** Either side of a relation. */
export type Relation<Type extends RelationType = RelationType, T extends AnyTable = AnyTable> =
  | ImplicitRelation<Type, T>
  | ExplicitRelation<Type, T>;

/** Any relation, regardless of its type parameters. */
export type AnyRelation = Relation;

class RelationInit<
  Type extends RelationType,
  Tables extends Record<string, AnyTable>,
  T extends keyof Tables,
> {
  readonly type: Type;
  readonly referencedTable: Tables[T];
  readonly referencer: AnyTable;
  constructor(type: Type, referencedTable: Tables[T], referencer: AnyTable) {
    this.type = type;
    this.referencedTable = referencedTable;
    this.referencer = referencer;
  }
}

/** Builder state of an implicit relation, until the schema resolves it. */
export class ImplicitRelationInit<
  Type extends RelationType,
  Tables extends Record<string, AnyTable>,
  T extends keyof Tables,
> extends RelationInit<Type, Tables, T> {
  /** Resolve the relation against the explicit relation that implies it, and link the two. */
  init(ormName: string, impliedBy: ExplicitRelation): ImplicitRelation<Type, Tables[T]> {
    const output: ImplicitRelation<Type, Tables[T]> = {
      id: impliedBy.id,
      on: impliedBy.on.map(([left, right]) => [right, left] as const),
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

/** Builder state of an explicit relation, until the schema builds it. */
export class ExplicitRelationInit<
  Type extends RelationType,
  Tables extends Record<string, AnyTable>,
  T extends keyof Tables,
> extends RelationInit<Type, Tables, T> {
  private foreignKeyConfig: Partial<ForeignKeyConfig> | undefined = undefined;
  implyingRelationName: string | undefined = undefined;
  on: Array<readonly [string, string]> = [];

  /** Name the implicit relation on the target table that this relation implies. Needed when several explicit relations target the same table. */
  imply(implyingRelationName: string): this {
    this.implyingRelationName = implyingRelationName;
    return this;
  }

  /**
   * Define the foreign key. Required for every explicit relation.
   * In `fumadb` relation mode the constraint is enforced by FumaDB instead of the database.
   */
  foreignKey(config: Partial<ForeignKeyConfig> = {}): this {
    this.foreignKeyConfig = config;
    return this;
  }

  private initForeignKey(ormName: string): ForeignKey | undefined {
    const config = this.foreignKeyConfig;
    if (config === undefined) return undefined;
    const columns: Array<AnyColumn> = [];
    const referencedColumns: Array<AnyColumn> = [];
    for (const [left, right] of this.on) {
      const leftColumn = this.referencer.columns[left];
      const rightColumn = this.referencedTable.columns[right];
      if (leftColumn === undefined || rightColumn === undefined) continue;
      columns.push(leftColumn);
      referencedColumns.push(rightColumn);
    }
    return {
      columns,
      referencedColumns,
      referencedTable: this.referencedTable,
      table: this.referencer,
      name:
        config.name ?? `${this.referencer.ormName}_${this.referencedTable.ormName}_${ormName}_fk`,
      onDelete: config.onDelete ?? "RESTRICT",
      onUpdate: config.onUpdate ?? "RESTRICT",
    };
  }

  /** Build the relation and its foreign key under the ORM name it was declared with. */
  init(ormName: string): ExplicitRelation<Type, Tables[T]> {
    let id = `${this.referencer.ormName}_${this.referencedTable.ormName}`;
    if (this.implyingRelationName !== undefined) id += `_${this.implyingRelationName}`;
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
}

/** Any relation builder state a `relations` callback may return. */
export type AnyRelationInit<Tables extends Record<string, AnyTable>> =
  | ImplicitRelationInit<RelationType, Tables, keyof Tables>
  | ExplicitRelationInit<RelationType, Tables, keyof Tables>;

/** The builder a `relations` callback receives for one table. */
export interface RelationBuilder<
  Tables extends Record<string, AnyTable> = Record<string, AnyTable>,
  K extends keyof Tables = keyof Tables,
> {
  /** Implicit one-to-one relation, resolved against the explicit relation on the other table. */
  one<T extends keyof Tables>(another: T): ImplicitRelationInit<"one", Tables, T>;
  /** Explicit one-to-one or many-to-one relation joined on `[thisColumn, targetColumn]` pairs. */
  one<T extends keyof Tables>(
    another: T,
    ...on: Array<readonly [keyof Tables[K]["columns"], keyof Tables[T]["columns"]]>
  ): ExplicitRelationInit<"one", Tables, T>;
  /** Implicit one-to-many relation. */
  many<T extends keyof Tables>(another: T): ImplicitRelationInit<"many", Tables, T>;
}

/** Build the relation builder for one table. Raises a `SchemaDefinitionError` for unknown table names. */
export const relationBuilder = <Tables extends Record<string, AnyTable>, K extends keyof Tables>(
  tables: Tables,
  key: K,
): RelationBuilder<Tables, K> => {
  const referencer = tables[key];
  if (referencer === undefined)
    throw new SchemaDefinitionError(`Unknown table "${String(key)}" in relations.`);
  const target = (another: keyof Tables): Tables[keyof Tables] => {
    const found = tables[another];
    if (found === undefined) {
      throw new SchemaDefinitionError(
        `Relation on "${String(key)}" targets unknown table "${String(another)}".`,
      );
    }
    return found;
  };
  return {
    one(another: keyof Tables, ...on: Array<readonly [PropertyKey, PropertyKey]>) {
      if (on.length > 0) {
        const init = new ExplicitRelationInit("one", target(another), referencer);
        init.on = on.map(([left, right]) => [String(left), String(right)] as const);
        return init;
      }
      return new ImplicitRelationInit("one", target(another), referencer);
    },
    many(another) {
      return new ImplicitRelationInit("many", target(another), referencer);
    },
  } as RelationBuilder<Tables, K>;
};

/** Foreign key with all identifiers resolved to SQL names. */
export interface CompiledForeignKey {
  readonly name: string;
  readonly table: string;
  readonly columns: ReadonlyArray<string>;
  readonly referencedTable: string;
  readonly referencedColumns: ReadonlyArray<string>;
  readonly onUpdate: ForeignKeyAction;
  readonly onDelete: ForeignKeyAction;
}

/** Resolve a foreign key's tables and columns to their SQL names. */
export const compileForeignKey = (key: ForeignKey): CompiledForeignKey => ({
  name: key.name,
  onUpdate: key.onUpdate,
  onDelete: key.onDelete,
  table: key.table.names.sql,
  referencedTable: key.referencedTable.names.sql,
  referencedColumns: key.referencedColumns.map((col) => col.names.sql),
  columns: key.columns.map((col) => col.names.sql),
});
