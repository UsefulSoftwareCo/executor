import type { AnySchema, AnyTable, ForeignKey } from "../../schema";
import { type Condition, ConditionType } from "../condition-builder";
import type { ORMAdapter } from "../orm";

export async function checkForeignKeyOnInsert(
  orm: ORMAdapter,
  key: ForeignKey,
  inserts: Record<string, unknown>[]
) {
  const ifMatchEntry: Condition[] = [];

  function shouldSkipChecking(insert: Record<string, unknown>) {
    for (const priorInsert of inserts) {
      if (priorInsert === insert) break;

      // duplicated referencing row to check
      if (
        key.columns.every(
          (col) => insert[col.ormName] === priorInsert[col.ormName]
        )
      )
        return true;

      // if in the same `createMany()` call, the referencing record is also created.
      if (
        key.table === key.referencedTable &&
        key.columns.every(
          (col, i) =>
            insert[col.ormName] ===
            priorInsert[key.referencedColumns[i].ormName]
        )
      ) {
        return true;
      }
    }

    return false;
  }

  for (const insert of inserts) {
    if (shouldSkipChecking(insert)) continue;

    const ifMatchColumn: Condition[] = [];
    let containsNull = false;

    for (let i = 0; i < key.columns.length; i++) {
      const col = key.columns[i];
      const referencedCol = key.referencedColumns[i];

      // ignore NULL/undefined values
      if (insert[col.ormName] == null) {
        containsNull = true;
        break;
      }

      ifMatchColumn.push({
        type: ConditionType.Compare,
        a: referencedCol,
        operator: "=",
        b: insert[col.ormName],
      });
    }

    if (!containsNull)
      ifMatchEntry.push({
        type: ConditionType.And,
        items: ifMatchColumn,
      });
  }

  if (ifMatchEntry.length === 0) return;
  const count = await orm.count(key.referencedTable, {
    where: {
      type: ConditionType.Or,
      items: ifMatchEntry,
    },
  });

  if (count < ifMatchEntry.length) errorForeignKey(key);
}

async function exists(orm: ORMAdapter, table: AnyTable, where: Condition) {
  const result = await orm.findFirst(table, {
    select: [table.getIdColumn().ormName],
    where,
  });

  return result !== null;
}

async function foreignKeyOnUpdate(
  orm: ORMAdapter,
  key: ForeignKey,
  set: Record<string, unknown>,
  targets: Record<string, unknown>[]
) {
  const isAffected: Condition = {
    type: ConditionType.Or,
    items: [],
  };

  const updated = key.referencedColumns.some(
    (col) => set[col.ormName] !== undefined
  );
  if (!updated) return;

  // build filters to filter affected rows
  for (const target of targets) {
    const condition: Condition = {
      type: ConditionType.And,
      items: [],
    };

    let containsNull = false;

    for (let i = 0; i < key.columns.length; i++) {
      const col = key.columns[i];
      const referencedCol = key.referencedColumns[i];

      if (target[referencedCol.ormName] === null) {
        containsNull = true;
        break;
      }

      condition.items.push({
        type: ConditionType.Compare,
        a: col,
        operator: "=",
        b: target[referencedCol.ormName],
      });
    }

    if (!containsNull) isAffected.items.push(condition);
  }

  if (isAffected.items.length === 0) return;
  if (key.onUpdate === "RESTRICT") {
    if (await exists(orm, key.table, isAffected)) errorForeignKey(key);
    return;
  }

  const mappedSet: Record<string, unknown> = {};

  for (let i = 0; i < key.columns.length; i++) {
    const col = key.columns[i].ormName;
    const referencedCol = key.referencedColumns[i].ormName;

    mappedSet[col] = key.onUpdate === "CASCADE" ? set[referencedCol] : null;
  }

  await orm.updateMany(key.table, {
    where: isAffected,
    set: mappedSet as any,
  });
}

export function createSoftForeignKey(
  schema: AnySchema,
  {
    generateInsertValuesDefault,
    ...orm
  }: Omit<ORMAdapter, "upsert"> & {
    /**
     * Soft foreign key requires generating default values for insert ahead of time.
     *
     * It will be automatically passed to your `create/createMany` functions.
     */
    generateInsertValuesDefault: (
      table: AnyTable,
      values: Record<string, unknown>
    ) => Record<string, unknown>;
  }
): ORMAdapter {
  // table name -> foreign key referencing it
  const childForeignKeys = new Map<string, ForeignKey[]>();

  for (const table of Object.values(schema.tables)) {
    for (const key of table.foreignKeys) {
      const name = key.referencedTable.ormName;

      const list = childForeignKeys.get(name) ?? [];
      list.push(key);
      childForeignKeys.set(name, list);
    }
  }

  if (!orm.transaction)
    throw new Error("native `transaction` required for soft foreign key.");

  return {
    ...orm,
    async updateMany(table, { set, where }) {
      const foreignKeys = childForeignKeys.get(table.ormName);
      if (!foreignKeys) return orm.updateMany(table, { set, where });

      const idColumnName = table.getIdColumn().ormName;
      const targets = await orm.findMany(table, { select: true, where });

      await orm.transaction?.(async (tx) => {
        for (const key of foreignKeys) {
          await foreignKeyOnUpdate(tx.internal, key, set, targets);
        }

        await orm.updateMany(table, {
          set,
          where: {
            type: ConditionType.Compare,
            a: table.columns[idColumnName],
            operator: "in",
            b: targets.map((target) => target[idColumnName]),
          },
        });
      });
    },
    // ignore original `upsert` so we can re-use our logic
    async upsert(table, v) {
      const target = await orm.findFirst(table, {
        select: true,
        where: v.where,
      });

      if (target === null) {
        await this.createMany(table, [v.create]);
      } else {
        const idColumn = table.getIdColumn();

        await this.updateMany(table, {
          set: v.update,
          where: {
            type: ConditionType.Compare,
            a: table.columns[idColumn.ormName],
            operator: "=",
            b: target[idColumn.ormName],
          },
        });
      }
    },
    async create(table, values) {
      values = generateInsertValuesDefault(table, values);

      await Promise.all(
        table.foreignKeys.map((key) =>
          checkForeignKeyOnInsert(this, key, [values])
        )
      );
      return orm.create(table, values);
    },
    async createMany(table, values) {
      values = values.map((value) => generateInsertValuesDefault(table, value));

      await Promise.all(
        table.foreignKeys.map((key) =>
          checkForeignKeyOnInsert(this, key, values)
        )
      );
      return orm.createMany(table, values);
    },
    async deleteMany(table, v) {
      const foreignKeys = childForeignKeys.get(table.ormName);
      if (!foreignKeys) return orm.deleteMany(table, v);
      const targets = await orm.findMany(table, {
        select: true,
        where: v.where,
      });

      for (const key of foreignKeys) {
        const isAffected: Condition = {
          type: ConditionType.Or,
          items: [],
        };

        for (const target of targets) {
          const isReferencingTarget: Condition = {
            type: ConditionType.And,
            items: [],
          };
          let containsNull = false;

          for (let i = 0; i < key.columns.length; i++) {
            const targetValue = target[key.referencedColumns[i].ormName];

            if (targetValue === null) {
              containsNull = true;
              break;
            }

            isReferencingTarget.items.push({
              type: ConditionType.Compare,
              a: key.columns[i],
              operator: "=",
              b: targetValue,
            });
          }

          if (!containsNull) isAffected.items.push(isReferencingTarget);
        }

        if (key.onDelete === "CASCADE") {
          await orm.deleteMany(key.table, {
            where: isAffected,
          });
        } else if (key.onDelete === "SET NULL") {
          const set: Record<string, unknown> = {};

          for (const col of key.columns) {
            set[col.ormName] = null;
          }

          await orm.updateMany(key.table, {
            set: set as any,
            where: isAffected,
          });
        } else if (await exists(this, key.table, isAffected)) {
          errorForeignKey(key);
        }
      }

      const idColumnName = table.getIdColumn().ormName;
      return orm.deleteMany(table, {
        where: {
          type: ConditionType.Compare,
          a: table.columns[idColumnName],
          operator: "in",
          b: targets.map((target) => target[idColumnName]),
        },
      });
    },
  };
}

function errorForeignKey(key: ForeignKey): never {
  throw new Error(`foreign constraint failed ${key.name}`);
}
