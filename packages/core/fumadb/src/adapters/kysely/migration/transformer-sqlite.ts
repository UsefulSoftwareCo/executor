import type { MigrationTransformer } from "../../../migration-engine/create";
import type {
  ColumnOperation,
  MigrationOperation,
} from "../../../migration-engine/shared";
import type { AnyTable } from "../../../schema";

const SupportedColumnOperations: ColumnOperation["type"][] = [
  "create-column",
  "rename-column",
];

export const transformerSQLite: MigrationTransformer = {
  afterAuto(operations, { prev, next }) {
    const operationTables: (AnyTable | null)[] = [];
    const nameToTable = new Map<string, AnyTable>();
    const recreate = new Set<AnyTable>();

    for (const table of Object.values(prev.tables)) {
      nameToTable.set(table.names.sql, table);
    }

    for (const op of operations) {
      let table: AnyTable | undefined ;

      switch (op.type) {
        case "create-table": {
          table = op.value;
          nameToTable.set(op.value.names.sql, table);
          break;
        }
        case "rename-table": {
          table = nameToTable.get(op.from);
          if (!table) break;

          nameToTable.set(op.to, table);
          nameToTable.delete(op.from);
          break;
        }
        case "add-unique-constraint":
        case "drop-unique-constraint": {
          table = nameToTable.get(op.table);
          break;
        }
        case "add-foreign-key":
        case "drop-foreign-key": {
          table = nameToTable.get(op.table);
          if (!table) break;

          recreate.add(table);
          break;
        }
        case "update-table": {
          table = nameToTable.get(op.name);
          if (
            !table ||
            op.value.every((action) =>
              SupportedColumnOperations.includes(action.type)
            )
          )
            break;

          recreate.add(table);
          break;
        }
        case "drop-table": {
          table = nameToTable.get(op.name);
          if (!table) break;

          nameToTable.delete(op.name);
          recreate.delete(table);
        }
      }

      operationTables.push(table ?? null);
    }

    // remove all operations on the recreating tables, as the recreated one will be 100% consistent with target schema
    operations = operations.filter((_, i) => {
      const table = operationTables[i];

      return !table || !recreate.has(table);
    });

    const post: (() => void)[] = [];
    for (const prevTable of recreate) {
      const nextTable = next.tables[prevTable.ormName];
      if (!nextTable) continue;

      for (const con of prevTable.getUniqueConstraints()) {
        operations.push({
          type: "drop-unique-constraint",
          table: prevTable.names.sql,
          name: con.name,
        });
      }

      const tempTable =
        nextTable.names.sql === prevTable.names.sql
          ? {
              ...nextTable,
              names: {
                ...nextTable.names,
                sql: `_temp_${nextTable.names.sql}`,
              },
            }
          : nextTable;

      operations.push({
        type: "create-table",
        value: tempTable,
      });

      post.push(() => {
        operations.push(...transferTable(prevTable, tempTable));

        if (tempTable !== nextTable)
          operations.push({
            type: "rename-table",
            from: tempTable.names.sql,
            to: nextTable.names.sql,
          });
      });
    }

    for (const item of post) item();

    return operations;
  },
};

function transferTable(from: AnyTable, to: AnyTable): MigrationOperation[] {
  const tempName =
    to.names.sql === from.names.sql ? `_temp_${to.names.sql}` : to.names.sql;

  const colNames: string[] = [];
  const values: string[] = [];
  for (const prevCol of Object.values(from.columns)) {
    const nextCol = to.columns[prevCol.ormName];
    if (!nextCol) continue;

    colNames.push(`"${nextCol.names.sql}"`);
    values.push(`"${prevCol.names.sql}" as "${nextCol.names.sql}"`);
  }

  return [
    {
      type: "custom",
      sql: `INSERT INTO "${tempName}" (${colNames.join(", ")}) SELECT ${values.join(", ")} FROM "${from.names.sql}"`,
    },
    {
      type: "drop-table",
      name: from.names.sql,
    },
  ];
}
