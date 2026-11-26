import type { MigrationTransformer } from "../../contracts/migration.ts";
import type { ColumnOperation, MigrationOperation } from "../../contracts/migration-operation.ts";
import type { AnyTable } from "../../contracts/schema/table.ts";

const supportedColumnOperations: ReadonlyArray<ColumnOperation["type"]> = [
  "create-column",
  "rename-column",
];

const temporaryName = (name: string): string => `_temp_${name}`;

const transferTable = (from: AnyTable, to: AnyTable): ReadonlyArray<MigrationOperation> => {
  const target = to.names.sql === from.names.sql ? temporaryName(to.names.sql) : to.names.sql;
  const columns: Array<string> = [];
  const values: Array<string> = [];
  for (const previous of Object.values(from.columns)) {
    const next = to.columns[previous.ormName];
    if (next === undefined) continue;
    columns.push(`"${next.names.sql}"`);
    values.push(`"${previous.names.sql}" as "${next.names.sql}"`);
  }
  return [
    {
      type: "custom",
      sql: `INSERT INTO "${target}" (${columns.join(", ")}) SELECT ${values.join(", ")} FROM "${from.names.sql}"`,
    },
    { type: "drop-table", name: from.names.sql },
  ];
};

export const sqliteTransformer: MigrationTransformer = {
  afterAuto(operations, { next, prev }) {
    const operationTables: Array<AnyTable | undefined> = [];
    const nameToTable = new Map<string, AnyTable>();
    const recreate = new Set<AnyTable>();

    for (const table of Object.values(prev.tables)) nameToTable.set(table.names.sql, table);

    for (const operation of operations) {
      let table: AnyTable | undefined;
      switch (operation.type) {
        case "create-table": {
          table = operation.value;
          nameToTable.set(operation.value.names.sql, table);
          break;
        }
        case "rename-table": {
          table = nameToTable.get(operation.from);
          if (table === undefined) break;
          nameToTable.set(operation.to, table);
          nameToTable.delete(operation.from);
          break;
        }
        case "add-unique-constraint":
        case "drop-unique-constraint": {
          table = nameToTable.get(operation.table);
          break;
        }
        case "add-foreign-key":
        case "drop-foreign-key": {
          table = nameToTable.get(operation.table);
          if (table === undefined) break;
          recreate.add(table);
          break;
        }
        case "update-table": {
          table = nameToTable.get(operation.name);
          if (table === undefined) break;
          if (operation.value.every((action) => supportedColumnOperations.includes(action.type)))
            break;
          recreate.add(table);
          break;
        }
        case "drop-table": {
          table = nameToTable.get(operation.name);
          if (table === undefined) break;
          nameToTable.delete(operation.name);
          recreate.delete(table);
          break;
        }
      }
      operationTables.push(table);
    }

    const out: Array<MigrationOperation> = operations.filter((_, index) => {
      const table = operationTables[index];
      return table === undefined || !recreate.has(table);
    });

    const transfers: Array<() => void> = [];
    for (const previous of recreate) {
      const target = next.tables[previous.ormName];
      if (target === undefined) continue;

      for (const constraint of previous.getUniqueConstraints()) {
        out.push({
          type: "drop-unique-constraint",
          table: previous.names.sql,
          name: constraint.name,
        });
      }

      const temporary: AnyTable =
        target.names.sql === previous.names.sql
          ? { ...target, names: { ...target.names, sql: temporaryName(target.names.sql) } }
          : target;

      out.push({ type: "create-table", value: temporary });

      transfers.push(() => {
        out.push(...transferTable(previous, temporary));
        if (temporary !== target) {
          out.push({ type: "rename-table", from: temporary.names.sql, to: target.names.sql });
        }
      });
    }
    for (const transfer of transfers) transfer();

    return out;
  },
};
