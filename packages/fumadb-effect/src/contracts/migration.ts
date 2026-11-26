import type { Effect, Option, Result } from "effect";
import type { SqlError } from "effect/sql/SqlError";
import type { MigrationError } from "./errors.ts";
import type { LibraryConfig } from "./adapter.ts";
import type { Provider, RelationMode } from "./provider.ts";
import type { NameVariantsConfig } from "./schema/names.ts";
import type { AnySchema } from "./schema/schema.ts";
import type { MigrationOperation } from "./migration-operation.ts";
import type { generateMigrationFromSchema } from "../implementation/migration/diff.ts";

export interface MigrateOptions {
  readonly mode?: "from-schema" | "from-database";
  readonly updateSettings?: boolean;
  readonly unsafe?: boolean;
}

export interface MigrationResult<R> {
  readonly operations: ReadonlyArray<MigrationOperation>;
  readonly sql: Option.Option<string>;
  readonly execute: Effect.Effect<void, MigrationError | SqlError, R>;
}

export interface Migrator<R> {
  readonly version: Effect.Effect<Option.Option<string>, SqlError, R>;
  readonly nameVariants: Effect.Effect<Option.Option<NameVariantsConfig>, SqlError, R>;
  readonly next: Effect.Effect<Option.Option<AnySchema>, SqlError, R>;
  readonly previous: Effect.Effect<Option.Option<AnySchema>, SqlError, R>;
  readonly up: (
    options?: MigrateOptions,
  ) => Effect.Effect<MigrationResult<R>, MigrationError | SqlError, R>;
  readonly down: (
    options?: MigrateOptions,
  ) => Effect.Effect<MigrationResult<R>, MigrationError | SqlError, R>;
  readonly migrateTo: (
    version: string,
    options?: MigrateOptions,
  ) => Effect.Effect<MigrationResult<R>, MigrationError | SqlError, R>;
  readonly migrateToLatest: (
    options?: MigrateOptions,
  ) => Effect.Effect<MigrationResult<R>, MigrationError | SqlError, R>;
}

export interface MigrationTransformer {
  readonly afterAuto?: (
    operations: ReadonlyArray<MigrationOperation>,
    context: {
      readonly options: MigrateOptions;
      readonly prev: AnySchema;
      readonly next: AnySchema;
    },
  ) => ReadonlyArray<MigrationOperation>;
  readonly afterAll?: (
    operations: ReadonlyArray<MigrationOperation>,
    context: { readonly prev: AnySchema; readonly next: AnySchema },
  ) => ReadonlyArray<MigrationOperation>;
}

export interface MigrationEngineOptions<R> {
  readonly libConfig: LibraryConfig;
  readonly userConfig: {
    readonly provider: Provider;
    readonly relationMode?: RelationMode;
    readonly dropUnusedTables?: boolean;
    readonly dropUnusedColumns?: boolean;
  };
  readonly executor: (
    operations: ReadonlyArray<MigrationOperation>,
  ) => Effect.Effect<void, MigrationError | SqlError, R>;
  readonly generateMigrationFromSchema?: typeof generateMigrationFromSchema;
  readonly generateMigrationFromDatabase?: (options: {
    readonly target: AnySchema;
    readonly dropUnusedColumns: boolean;
  }) => Effect.Effect<ReadonlyArray<MigrationOperation>, MigrationError | SqlError, R>;
  readonly settings: {
    readonly getVersion: Effect.Effect<Option.Option<string>, SqlError, R>;
    readonly getNameVariants: Effect.Effect<Option.Option<NameVariantsConfig>, SqlError, R>;
    readonly updateSettingsInMigration: (
      schema: AnySchema,
    ) => Effect.Effect<ReadonlyArray<MigrationOperation>, SqlError, R>;
  };
  readonly toSql?: (
    operations: ReadonlyArray<MigrationOperation>,
  ) => Result.Result<string, MigrationError>;
  readonly transformers?: ReadonlyArray<MigrationTransformer>;
}
