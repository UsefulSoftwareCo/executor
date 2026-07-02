import type { MongoClient } from "mongodb";
import { column, idColumn, table } from "../../schema";
import type { PrismaClient } from "../../shared/prisma";
import type { Provider } from "../../shared/providers";
import type { FumaDBAdapter } from "..";
import { generateSchema } from "./generate";
import { fromPrisma } from "./query";

export interface PrismaConfig {
  provider: Provider;
  prisma: PrismaClient;

  /**
   * The relation mode you're using, see https://prisma.io/docs/orm/prisma-schema/data-model/relations/relation-mode.
   *
   * Default to foreign keys on SQL databases, and `prisma` on MongoDB.
   */
  relationMode?: "prisma" | "foreign-keys";

  /**
   * Underlying database instance, highly recommended to provide so FumaDB can optimize some operations & indexes.
   *
   * supported: MongoDB
   */
  db?: MongoClient;
}

export function prismaAdapter(
  options: Omit<PrismaConfig, "prisma"> & {
    prisma: unknown;
  }
): FumaDBAdapter {
  const config = options as PrismaConfig;
  const settingsModel = (namespace: string) => `private_${namespace}_settings`;

  return {
    name: "prisma",
    createORM(schema) {
      return fromPrisma(schema, config);
    },
    async getSchemaVersion() {
      const prisma = config.prisma;
      const settings = settingsModel(this.namespace);
      if (!(settings in prisma)) return;

      // Try to find existing record first
      let result = await prisma[settings].findFirst({
        where: { key: "version" },
      });

      if (!result) {
        // If not found, try to create it (handles race conditions gracefully)
        try {
          result = await prisma[settings].create({
            data: { key: "version" },
          });
        } catch {
          // If create fails (unique constraint), another concurrent call created it
          result = await prisma[settings].findFirst({
            where: { key: "version" },
          });
        }
      }

      return result?.value as string | undefined;
    },
    generateSchema(schema, name) {
      const settings = settingsModel(this.namespace);
      const internalTable = table(settings, {
        key: idColumn("key", "varchar(255)"),
        value: column("value", "string").defaultTo(schema.version),
      });
      internalTable.ormName = settings;

      return {
        code: generateSchema(
          {
            ...schema,
            tables: {
              ...schema.tables,
              [settings]: internalTable,
            },
          },
          config.provider
        ),
        path: `./prisma/schema/${name}.prisma`,
      };
    },
  };
}
