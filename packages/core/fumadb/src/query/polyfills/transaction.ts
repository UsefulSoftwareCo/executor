import type { AnyTable } from "../../schema";
import { ConditionType } from "../condition-builder";
import { type ORMAdapter, toORM } from "../orm";

enum ActionType {
  Insert,
  Update,
  Delete,
  Sub,
}

type Action =
  | {
      type: ActionType.Delete;
      id: unknown;
      table: AnyTable;
      values: Record<string, unknown>;
    }
  | {
      type: ActionType.Insert;
      table: AnyTable;
      id: unknown;
    }
  | {
      type: ActionType.Update;
      id: unknown;
      table: AnyTable;
      updatedFields: string[];
      beforeUpdate: Record<string, unknown>;
    }
  | {
      type: ActionType.Sub;
      ctx: TransactionQuery;
    };

type TransactionQuery = ORMAdapter & {
  rollback: () => Promise<void>;
};

/**
 * Soft transaction support, doesn't support OCC.
 *
 * It works by reverting your operations when rollback, and during the process concurrent requests may conflict, hence it can be dangerous.
 *
 */
export function createTransaction(
  orm: Omit<ORMAdapter, "transaction">
): TransactionQuery {
  const stack: Action[] = [];

  return {
    ...orm,
    async rollback() {
      while (stack.length > 0) {
        const entry = stack.pop()!;
        if (entry.type === ActionType.Sub) {
          await entry.ctx.rollback?.();
          continue;
        }

        const table = entry.table;
        const idCol = table.getIdColumn();

        switch (entry.type) {
          case ActionType.Insert:
            await orm.deleteMany(table, {
              where: {
                type: ConditionType.Compare,
                a: idCol,
                operator: "=",
                b: entry.id,
              },
            });
            break;
          case ActionType.Update: {
            const set: Record<string, unknown> = {};
            for (const key of entry.updatedFields) {
              set[key] = entry.beforeUpdate[key];
            }
            await orm.updateMany(table, {
              where: {
                type: ConditionType.Compare,
                a: idCol,
                operator: "=",
                b: entry.id,
              },
              set: set as any,
            });
            break;
          }
          case ActionType.Delete:
            await orm.createMany(table, [entry.values]);
            break;
        }
      }
    },
    async create(table, values) {
      const result = await orm.create(table, values);
      const idField = table.getIdColumn().ormName;

      stack.push({ type: ActionType.Insert, id: result[idField], table });

      return result;
    },
    async createMany(table, values) {
      const result = await orm.createMany(table, values);

      for (const value of result) {
        stack.push({
          type: ActionType.Insert,
          table,
          id: value._id,
        });
      }

      return result;
    },
    async deleteMany(table, v) {
      const idCol = table.getIdColumn();
      const targets = await orm.findMany(table, {
        select: [idCol.ormName],
        where: v.where,
      });

      await orm.deleteMany(table, {
        where: {
          type: ConditionType.Compare,
          a: idCol,
          operator: "in",
          b: targets.map((target) => target[idCol.ormName]),
        },
      });

      for (const target of targets) {
        stack.push({
          type: ActionType.Delete,
          id: idCol,
          values: target,
          table,
        });
      }
    },
    async updateMany(table, v) {
      const idCol = table.getIdColumn();
      const targets = await orm.findMany(table, {
        select: [idCol.ormName],
        where: v.where,
      });

      await orm.updateMany(table, {
        set: v.set,
        where: {
          type: ConditionType.Compare,
          a: idCol,
          operator: "in",
          b: targets.map((target) => target[idCol.ormName]),
        },
      });

      const updatedFields = Object.keys(v.set);
      for (const target of targets) {
        stack.push({
          type: ActionType.Update,
          id: idCol,
          beforeUpdate: target,
          table,
          updatedFields,
        });
      }
    },
    async upsert(table, v) {
      const idCol = table.getIdColumn();

      const target = await orm.findFirst(table, {
        select: [idCol.ormName],
        where: v.where,
      });

      if (!target) {
        await this.createMany(table, [v.create]);
      } else {
        await this.updateMany(table, {
          where: {
            type: ConditionType.Compare,
            a: idCol,
            operator: "=",
            b: target[idCol.ormName],
          },
          set: v.update,
        });
      }
    },
    async transaction(run) {
      const ctx = createTransaction(this);

      try {
        const result = await run(toORM(ctx));

        stack.push({
          type: ActionType.Sub,
          ctx,
        });

        return result;
      } catch (e) {
        await ctx.rollback();
        throw e;
      }
    },
  };
}
