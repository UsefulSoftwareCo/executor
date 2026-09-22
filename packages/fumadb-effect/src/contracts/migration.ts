/** Migration plans, options, and storage adapter contracts. */
import type { Effect, Option, Result } from "effect";
import type { SqlError } from "effect/unstable/sql/SqlError";
import type { MigrationError } from "./errors.ts";
import type { LibraryConfig } from "./adapter.ts";
import type { Provider, RelationMode } from "./provider.ts";
import type { NameVariantsConfig } from "./schema/names.ts";
import type { AnySchema } from "./schema/schema.ts";
import type { MigrationOperation } from "./migration-operation.ts";
import type { generateMigrationFromSchema } from "../implementation/migration/diff.ts";

/** Options of every migration planner method. */
export interface MigrateOptions {
  /**
   * - `from-schema` (default): diff the stored schema version against the target.
   * - `from-database`: introspect the database and diff it against the target.
   */
  readonly mode?: "from-schema" | "from-database";
  /** Write the version and name variants into the settings table. Defaults to `true`. */
  readonly updateSettings?: boolean;
  /**
   * Allow operations that can lose data. Defaults to `false`, so an
   * unattended migration never drops anything.
   *
   * - `from-schema`: drops tables and columns the target schema no longer has.
   * - `from-database`: drops columns the target schema no longer has. Tables
   *   are never dropped here, because introspection also sees tables this
   *   library does not own.
   *
   * Without it, a kept column that is required and has no default is made
   * nullable, so the table stays writable. On SQLite that change recreates
   * the table from the target schema, which drops the column.
   */
  readonly unsafe?: boolean;
}

/** A planned migration: its operations, the rendered script, and the effect that applies it. */
export interface MigrationResult<R> {
  readonly operations: ReadonlyArray<MigrationOperation>;
  /**
   * The full script. `None` only when the adapter cannot render operations as
   * SQL text at all; an adapter that can but fails on this plan makes the
   * migration fail with a `MigrationError` instead of returning a partial
   * script.
   */
  readonly sql: Option.Option<string>;
  readonly execute: Effect.Effect<void, MigrationError | SqlError, R>;
}

/**
 * Plans and applies schema migrations. Every planner method returns a
 * {@link MigrationResult}; nothing changes until its `execute` runs.
 */
export interface Migrator<R> {
  /** The stored schema version, or `None` before initialisation. */
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

/** A hook an adapter uses to rewrite planned operations (the SQLite table-recreate strategy is one). */
export interface MigrationTransformer {
  /** Runs on automatically generated operations. */
  readonly afterAuto?: (
    operations: ReadonlyArray<MigrationOperation>,
    context: {
      readonly options: MigrateOptions;
      readonly prev: AnySchema;
      readonly next: AnySchema;
    },
  ) => ReadonlyArray<MigrationOperation>;
  /** Runs on every operation list, after settings updates are appended. */
  readonly afterAll?: (
    operations: ReadonlyArray<MigrationOperation>,
    context: { readonly prev: AnySchema; readonly next: AnySchema },
  ) => ReadonlyArray<MigrationOperation>;
}

/** What an adapter supplies to {@link createMigrator}. */
export interface MigrationEngineOptions<R> {
  readonly libConfig: LibraryConfig;
  readonly userConfig: {
    readonly provider: Provider;
    readonly relationMode?: RelationMode;
    /**
     * Drop settings the adapter decides itself. When either is set, `unsafe`
     * does not change it; when both are absent, `unsafe` decides.
     */
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
    /** Name variants stored by the last migration, so consumer renames can be migrated. */
    readonly getNameVariants: Effect.Effect<Option.Option<NameVariantsConfig>, SqlError, R>;
    readonly updateSettingsInMigration: (
      schema: AnySchema,
    ) => Effect.Effect<ReadonlyArray<MigrationOperation>, SqlError, R>;
  };
  /**
   * Render the plan as one SQL script. Omit it when the adapter has no SQL
   * text form at all; a plan the adapter cannot render fails the migration
   * with that `MigrationError`, so no caller sees an incomplete script.
   */
  readonly toSql?: (
    operations: ReadonlyArray<MigrationOperation>,
  ) => Result.Result<string, MigrationError>;
  readonly transformers?: ReadonlyArray<MigrationTransformer>;
}
