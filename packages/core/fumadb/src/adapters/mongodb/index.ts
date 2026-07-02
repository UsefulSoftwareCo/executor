import type { MongoClient } from "mongodb";
import { createMigrator, type Migrator } from "../../migration-engine/create";
import type { NameVariants } from "../../schema";
import { exportNameVariants } from "../../schema/export";
import type { LibraryConfig } from "../../shared/config";
import type { FumaDBAdapter } from "../";
import { execute } from "./migration/execute";
import { fromMongoDB } from "./query";

export interface MongoDBConfig {
  client: MongoClient;
}

export function mongoAdapter(options: MongoDBConfig): FumaDBAdapter {
  return {
    name: "mongodb",
    createORM(schema) {
      return fromMongoDB(schema, options.client);
    },
    createMigrationEngine() {
      return createMongoDBMigrator(this, options.client);
    },
    async getSchemaVersion() {
      const manager = createSettingsManager(this, options.client);
      return (await manager.get("version")) as string;
    },
  };
}

function createMongoDBMigrator(
  lib: LibraryConfig,
  client: MongoClient
): Migrator {
  const manager = createSettingsManager(lib, client);

  return createMigrator({
    ...lib,
    libConfig: lib,
    userConfig: {
      provider: "mongodb",
    },
    settings: {
      async getVersion() {
        const result = await manager.get("version");
        if (typeof result === "string") return result;
      },
      async getNameVariants() {
        const result = await manager.get("name-variants");
        if (result) return result as Record<string, NameVariants>;
      },
      updateSettingsInMigration(schema) {
        return [
          {
            type: "custom",
            key: "version",
            value: schema.version,
          },
          {
            type: "custom",
            key: "name-variants",
            value: exportNameVariants(schema),
          },
        ];
      },
    },
    async executor(operations) {
      const session = client.startSession();

      try {
        for (const op of operations) {
          await execute(op, { client, session }, (node) =>
            manager.set(node.key as string, node.value)
          ).catch((e) => {
            console.error("failed at", op, e);
            throw e;
          });
        }
      } finally {
        await session.endSession();
      }
    },
  });
}

function createSettingsManager(lib: LibraryConfig, client: MongoClient) {
  const db = client.db();
  const collection = db.collection<{
    key: string;
    value: unknown;
  }>(`private_${lib.namespace}_settings`);

  return {
    async get(key: string) {
      const result = await collection.findOne({
        key,
      });

      return result?.value;
    },
    async set(key: string, value: unknown) {
      const result = await collection.updateOne(
        {
          key,
        },
        { $set: { value } }
      );

      if (result.matchedCount === 0) {
        await collection.insertOne({ key, value });
      }
    },
  };
}
