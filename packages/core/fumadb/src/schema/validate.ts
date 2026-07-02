import { valid } from "semver";
import { deepEqual } from "../utils/deep-equal";
import {
  type AnyColumn,
  type AnyRelation,
  type AnySchema,
  type AnyTable,
  type ForeignKey,
  IdColumn,
} from "./create";

export function validateSchema(schema: AnySchema) {
  if (!valid(schema.version)) {
    throw new Error(`the version ${schema.version} is invalid.`);
  }

  const tables = Object.values(schema.tables);

  function validateForeignKey(key: ForeignKey) {
    if (
      key.table === key.referencedTable &&
      (key.onUpdate !== "RESTRICT" || key.onDelete !== "RESTRICT")
    ) {
      throw new Error(
        `[${key.name}] Due to the limitations of MSSQL & Prisma MongoDB, you cannot specify other foreign key actions than "RESTRICT" for self-referencing foreign keys.`
      );
    }

    for (const col of key.columns) {
      if (
        !col.isNullable &&
        (key.onUpdate === "SET NULL" || key.onDelete === "SET NULL")
      ) {
        throw new Error(
          `[${key.name}] You are using "SET NULL" as foreign key action, but some columns are non-nullable.`
        );
      }
    }
  }

  function isCompositeColumnsUnique(table: AnyTable, columns: AnyColumn[]) {
    if (columns.length === 1 && columns[0] instanceof IdColumn) return true;

    const columnNames = columns.map((col) => col.ormName);
    for (const con of table.getUniqueConstraints()) {
      if (
        deepEqual(
          con.columns.map((col) => col.ormName),
          columnNames
        )
      )
        return true;
    }

    return false;
  }

  function validateRelation(relation: AnyRelation) {
    if (!relation.implied && !relation.foreignKey) {
      throw new Error(
        `[${relation.name}] You must define foreign key for explicit relations due the limitations of Prisma.`
      );
    }

    // ignore implied
    if (relation.implied) return;

    if (
      relation.implying?.type === "one" &&
      !isCompositeColumnsUnique(
        relation.referencer,
        relation.on.map(([left]) => relation.referencer.columns[left])
      )
    ) {
      throw new Error(
        `[${relation.name}] one-to-one relations require both sides to be unique or primary key.`
      );
    }

    if (
      !isCompositeColumnsUnique(
        relation.table,
        relation.on.map(([, right]) => relation.table.columns[right])
      )
    )
      throw new Error(
        `[${relation.name}] For any explicit relations, the referenced columns must be unique or primary key.`
      );
  }

  for (const table of tables) {
    for (const foreignKey of table.foreignKeys) {
      validateForeignKey(foreignKey);
    }

    for (const relation of Object.values(table.relations)) {
      validateRelation(relation);
    }
  }
}
