/**
 * Structural validation run when a schema is constructed.
 */
import { SchemaDefinitionError } from "../errors.ts";
import { isValid } from "../version.ts";
import { type AnyColumn, isIdColumn } from "./column.ts";
import type { AnyRelation, ForeignKey } from "./relation.ts";
import type { AnySchema } from "./schema.ts";
import type { AnyTable } from "./table.ts";

const sameNames = (a: ReadonlyArray<AnyColumn>, b: ReadonlyArray<AnyColumn>): boolean =>
  a.length === b.length && a.every((col, i) => col.ormName === b[i]?.ormName);

const isCompositeUnique = (table: AnyTable, columns: ReadonlyArray<AnyColumn>): boolean => {
  const first = columns[0];
  if (columns.length === 1 && first !== undefined && isIdColumn(first)) return true;
  return table.getUniqueConstraints().some((con) => sameNames(con.columns, columns));
};

/**
 * A foreign key must point at a table of the same schema. A stale reference
 * would compile to SQL that names a table the migration never creates.
 */
const validateForeignKeyTarget = (key: ForeignKey, tables: Record<string, AnyTable>): void => {
  for (const table of [key.table, key.referencedTable]) {
    if (tables[table.ormName] === table) continue;
    throw new SchemaDefinitionError(
      `[${key.name}] The foreign key references the table "${table.ormName}", which is not part of this schema.`,
    );
  }
};

const validateForeignKey = (key: ForeignKey): void => {
  key.columns.forEach((col, index) => {
    const referenced = key.referencedColumns[index];
    if (referenced !== undefined && col.type !== referenced.type) {
      throw new SchemaDefinitionError(
        `[${key.name}] Column "${col.table.ormName}.${col.ormName}" is stored as ${col.type} but references "${referenced.table.ormName}.${referenced.ormName}" stored as ${referenced.type}; give both the same schema (for an id, a Schema.String is varchar(255): use Schema.String.check(Schema.isMaxLength(255)) or pass { type: "varchar(255)" }).`,
      );
    }
  });
  if (
    key.table === key.referencedTable &&
    (key.onUpdate !== "RESTRICT" || key.onDelete !== "RESTRICT")
  ) {
    throw new SchemaDefinitionError(
      `[${key.name}] Self-referencing foreign keys only support the "RESTRICT" action (MSSQL limitation).`,
    );
  }
  for (const col of key.columns) {
    if (!col.isNullable && (key.onUpdate === "SET NULL" || key.onDelete === "SET NULL")) {
      throw new SchemaDefinitionError(
        `[${key.name}] You are using "SET NULL" as foreign key action, but some columns are non-nullable.`,
      );
    }
  }
};

const validateRelation = (relation: AnyRelation): void => {
  if (relation.implied) return;
  if (relation.foreignKey === undefined) {
    throw new SchemaDefinitionError(
      `[${relation.name}] You must define a foreign key for explicit relations.`,
    );
  }
  const referencerColumns = relation.on
    .map(([left]) => relation.referencer.columns[left])
    .filter((c): c is AnyColumn => c !== undefined);
  const targetColumns = relation.on
    .map(([, right]) => relation.table.columns[right])
    .filter((c): c is AnyColumn => c !== undefined);
  if (
    referencerColumns.length !== relation.on.length ||
    targetColumns.length !== relation.on.length
  ) {
    throw new SchemaDefinitionError(
      `[${relation.name}] The relation references a column that does not exist.`,
    );
  }
  if (
    relation.implying?.type === "one" &&
    !isCompositeUnique(relation.referencer, referencerColumns)
  ) {
    throw new SchemaDefinitionError(
      `[${relation.name}] one-to-one relations require both sides to be unique or primary key.`,
    );
  }
  if (!isCompositeUnique(relation.table, targetColumns)) {
    throw new SchemaDefinitionError(
      `[${relation.name}] For any explicit relations, the referenced columns must be unique or primary key.`,
    );
  }
};

/**
 * Check a schema's version, foreign keys, and relations.
 *
 * Throws a `SchemaDefinitionError` (a defect: an invalid definition is a
 * programmer error) for the first problem found.
 */
export const validateSchema = (schema: AnySchema): void => {
  if (!isValid(schema.version))
    throw new SchemaDefinitionError(`the version ${schema.version} is invalid.`);
  for (const table of Object.values(schema.tables)) {
    // Two keys of one name compile to the same constraint twice, which the
    // migration only discovers as "constraint already exists".
    const keyNames = new Set<string>();
    for (const key of table.foreignKeys) {
      if (keyNames.has(key.name))
        throw new SchemaDefinitionError(
          `[${key.name}] The table "${table.ormName}" declares this foreign key more than once.`,
        );
      keyNames.add(key.name);
      validateForeignKeyTarget(key, schema.tables);
      validateForeignKey(key);
    }
    for (const relation of Object.values(table.relations)) validateRelation(relation);
  }
};
