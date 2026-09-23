export {
  generateMigrationFromSchema,
  type GenerateMigrationOptions,
} from "./implementation/migration/diff.ts";
export { createMigrator } from "./implementation/migration/migrator.ts";
export type {
  MigrateOptions,
  MigrationEngineOptions,
  MigrationResult,
  MigrationTransformer,
  Migrator,
} from "./contracts/migration.ts";

export {
  type ColumnOperation,
  type CustomOperation,
  type ForeignKeyInfo,
  isColumnUpdated,
  type MigrationOperation,
  type TableOperation,
} from "./contracts/migration-operation.ts";
