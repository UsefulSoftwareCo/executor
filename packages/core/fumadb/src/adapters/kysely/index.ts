import { type Kysely, sql } from "kysely";
import { createMigrator, type Migrator } from "../../migration-engine/create";
import type {
  CustomOperation,
  MigrationOperation,
} from "../../migration-engine/shared";
import { exportNameVariants } from "../../schema/export";
import { schemaToDBType } from "../../schema/serialize";
import type { KyselyConfig, LibraryConfig } from "../../shared/config";
import type { SQLProvider } from "../../shared/providers";
import type { FumaDBAdapter } from "../";
import { generateMigration } from "./migration/auto-from-database";
import { execute } from "./migration/execute";
import { transformerSQLite } from "./migration/transformer-sqlite";
import { fromKysely } from "./query";

interface ModelNames {
  settings: string;
}

export function kyselyAdapter(config: KyselyConfig): FumaDBAdapter {
  return {
    name: "kysely",
    createORM(schema) {
      return fromKysely(schema, config);
    },
    getSchemaVersion() {
      const manager = createSettingsManager(config.db, config.provider, {
        settings: `private_${this.namespace}_settings`,
      });

      return manager.get("version");
    },
    createMigrationEngine() {
      return createSQLMigrator(this, config, {
        settings: `private_${this.namespace}_settings`,
      });
    },
  };
}

function createSQLMigrator(
  lib: LibraryConfig,
  config: KyselyConfig,
  modelNames: ModelNames
): Migrator {
  const manager = createSettingsManager(config.db, config.provider, modelNames);

  function onCustomNode(node: CustomOperation, db: Kysely<any>) {
    const statement = sql.raw(node.sql as string);

    return {
      compile() {
        return statement.compile(db);
      },
      execute() {
        return statement.execute(db);
      },
    };
  }

  async function getNameVariants() {
    const currentVariants = await manager.get("name-variants");
    if (!currentVariants) return;

    try {
      return JSON.parse(currentVariants);
    } catch (e) {
      console.warn("failed to parse stored name variants, skipping for now", e);
    }
  }

  function preprocess(operations: MigrationOperation[], db: Kysely<any>) {
    if (config.provider === "mysql") {
      operations.unshift({ type: "custom", sql: "SET FOREIGN_KEY_CHECKS = 0" });
      operations.push({ type: "custom", sql: "SET FOREIGN_KEY_CHECKS = 1" });
    } else if (config.provider === "sqlite") {
      operations.unshift({
        type: "custom",
        sql: "PRAGMA defer_foreign_keys = ON",
      });
    }

    const tsConfig = {
      ...config,
      db,
    };

    return operations.flatMap((op) =>
      execute(op, tsConfig, (node) => onCustomNode(node, db))
    );
  }

  return createMigrator({
    libConfig: lib,
    userConfig: config,
    async generateMigrationFromDatabase(options) {
      return generateMigration(options.target, config, {
        nameVariants: await getNameVariants(),
        internalTables: Object.values(modelNames),
        dropUnusedColumns: options.dropUnusedColumns,
      });
    },

    async executor(operations) {
      await config.db.transaction().execute(async (tx) => {
        for (const node of preprocess(operations, tx)) {
          try {
            await node.execute();
          } catch (e) {
            console.error("failed at", node.compile(), e);
            throw e;
          }
        }
      });
    },
    settings: {
      getVersion: () => manager.get("version"),
      getNameVariants,
      async updateSettingsInMigration(schema) {
        const settings = {
          version: schema.version,
          "name-variants": JSON.stringify(exportNameVariants(schema)),
        };

        const init = await manager.initIfNeeded();
        const statements: string[] = [];
        if (init) statements.push(init);

        for (const [k, v] of Object.entries(settings)) {
          if (init || !(await manager.get(k))) {
            statements.push(manager.insert(k, v));
            continue;
          }

          statements.push(manager.update(k, v));
        }

        return statements.map((statement) => ({
          type: "custom",
          sql: statement,
        }));
      },
    },
    sql: {
      toSql(operations) {
        const compiled = preprocess(operations, config.db).map(
          (m) => `${m.compile().sql};`
        );

        return compiled.join("\n\n");
      },
    },
    transformers: config.provider === "sqlite" ? [transformerSQLite] : [],
  });
}

function createSettingsManager(
  db: Kysely<any>,
  provider: SQLProvider,
  modelNames: ModelNames
) {
  const { settings } = modelNames;

  function initTable() {
    return db.schema
      .createTable(settings)
      .addColumn(
        "key",
        provider === "sqlite" ? "text" : "varchar(255)",
        (col) => col.primaryKey()
      )
      .addColumn(
        "value",
        sql.raw(schemaToDBType({ type: "string" }, provider)),
        (col) => col.notNull()
      );
  }

  let initPromise: Promise<void> | undefined;

  async function ensureSettingsTable() {
    initPromise ??= initTable()
      .ifNotExists()
      .execute()
      .then(() => undefined);
    await initPromise;
  }

  return {
    async get(key: string): Promise<string | undefined> {
      await ensureSettingsTable();
      const result = await db
        .selectFrom(settings)
        .where("key", "=", key)
        .select(["value"])
        .executeTakeFirst();
      return result?.value as string | undefined;
    },

    async initIfNeeded() {
      const tables = await db.introspection.getTables();
      if (tables.some((table) => table.name === settings)) return;

      return initTable().compile().sql;
    },

    insert(key: string, value: string) {
      return db
        .insertInto(settings)
        .values({
          key: sql.lit(key),
          value: sql.lit(value),
        })
        .compile().sql;
    },

    update(key: string, value: string) {
      return db
        .updateTable(settings)
        .set({
          value: sql.lit(value),
        })
        .where("key", "=", sql.lit(key))
        .compile().sql;
    },
  };
}
