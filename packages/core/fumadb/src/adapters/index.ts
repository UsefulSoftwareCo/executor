import type { Migrator } from "../migration-engine/create";
import type { AbstractQuery } from "../query";
import type { AnySchema } from "../schema";
import type { LibraryConfig } from "../shared/config";

export interface SettingsManagerConfig {
  models: {
    /**
     * unique table & collection name for library settings (binded to database)
     */
    settings: string;
  };
}

export interface FumaDBAdapterContext extends LibraryConfig {}

export interface FumaDBAdapter {
  /**
   * Name of the adapter
   */
  name: string;

  /**
   * Generate ORM schema based on FumaDB Schema
   */
  generateSchema?: (
    this: FumaDBAdapterContext,
    schema: AnySchema,
    schemaName: string
  ) => {
    code: string;
    path: string;
  };

  createORM(
    this: FumaDBAdapterContext,
    schema: AnySchema
  ): AbstractQuery<AnySchema>;

  /**
   * Get current schema version, undefined if not initialized.
   */
  getSchemaVersion(this: FumaDBAdapterContext): Promise<string | undefined>;

  createMigrationEngine?: (this: FumaDBAdapterContext) => Migrator;
}

export type FumaDBAdapterOptionsV1 = FumaDBAdapter;

export function createAdapter(
  _version: "v1",
  options: FumaDBAdapterOptionsV1
): FumaDBAdapter {
  return options;
}

export { memoryAdapter, type MemoryAdapterOptions, type MemoryDatabase } from "./memory";
