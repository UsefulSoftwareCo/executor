/**
 * The migration engine, independent of any provider.
 *
 * An adapter supplies how to read settings, execute operations, render SQL,
 * and optionally introspect the database. The engine chooses the source
 * schema (from stored version and name variants), the target schema, custom
 * `up` / `down` functions, and applies transformers.
 */
import { Effect, Option } from "effect";
import type { SqlError } from "effect/unstable/sql/SqlError";
import { MigrationError } from "../../contracts/errors.ts";
import { applyNameVariants } from "../../contracts/schema/names.ts";
import {
  type AnySchema,
  type MigrationContext,
  schema as makeSchema,
} from "../../contracts/schema/schema.ts";
import { compare, parseOrThrow, sameVariant, type Version } from "../../contracts/version.ts";
import { generateMigrationFromSchema } from "./diff.ts";
import type { MigrationOperation } from "../../contracts/migration-operation.ts";

import type {
  MigrateOptions,
  MigrationEngineOptions,
  MigrationResult,
  Migrator,
} from "../../contracts/migration.ts";

/**
 * Build a {@link Migrator} from adapter-supplied settings access, execution,
 * rendering, and optional introspection. Pure: no I/O until a method runs.
 */
export const createMigrator = <R>(options: MigrationEngineOptions<R>): Migrator<R> => {
  const {
    executor,
    generateMigrationFromDatabase,
    generateMigrationFromSchema: fromSchema = generateMigrationFromSchema,
    libConfig: { initialVersion = "0.0.0", schemas },
    settings,
    toSql,
    transformers = [],
    userConfig,
  } = options;

  const indexed = new Map<string, AnySchema>();
  indexed.set(initialVersion, makeSchema({ version: initialVersion, tables: {} }));
  for (const s of schemas) {
    if (indexed.has(s.version))
      throw new MigrationError({
        reason: "UnknownVersion",
        message: `Duplicated version: ${s.version}`,
      });
    indexed.set(s.version, s);
  }
  const sorted = [...schemas].sort((a, b) =>
    compare(parseOrThrow(a.version), parseOrThrow(b.version)),
  );

  const getSchemaByVersion = (version: string): Effect.Effect<AnySchema, MigrationError> => {
    const found = indexed.get(version);
    return found === undefined
      ? Effect.fail(
          new MigrationError({ reason: "UnknownVersion", message: `Invalid version ${version}` }),
        )
      : Effect.succeed(found);
  };

  const schemasOfVariant = (variant: Version): ReadonlyArray<AnySchema> =>
    sorted.filter((s) => sameVariant(parseOrThrow(s.version), variant));

  const currentVersion = Effect.map(
    settings.getVersion,
    Option.getOrElse(() => initialVersion),
  );

  const getCurrentSchema = Effect.gen(function* () {
    const version = yield* currentVersion;
    const nameVariants = yield* settings.getNameVariants;
    const current = yield* getSchemaByVersion(version);
    return Option.match(nameVariants, {
      onNone: () => current,
      onSome: (variants) => applyNameVariants(current, variants),
    });
  });

  const next: Migrator<R>["next"] = Effect.map(currentVersion, (version) => {
    const list = schemasOfVariant(parseOrThrow(version));
    const index = list.findIndex((s) => s.version === version);
    return Option.fromNullishOr(list[index + 1]);
  });

  const previous: Migrator<R>["previous"] = Effect.map(settings.getVersion, (stored) =>
    Option.flatMap(stored, (version) => {
      const list = schemasOfVariant(parseOrThrow(version));
      const index = list.findIndex((s) => s.version === version);
      return index <= 0 ? Option.none() : Option.fromNullishOr(list[index - 1]);
    }),
  );

  const migrateTo = Effect.fn("FumaDB.Migrator.migrateTo")(function* (
    version: string,
    migrateOptions: MigrateOptions = {},
  ): Effect.fn.Return<MigrationResult<R>, MigrationError | SqlError, R> {
    const { mode = "from-schema", unsafe = false, updateSettings = true } = migrateOptions;
    const targetSchema = yield* getSchemaByVersion(version);
    const currentSchema = yield* getCurrentSchema;

    const targetVersion = parseOrThrow(targetSchema.version);
    const current = parseOrThrow(currentSchema.version);
    let run:
      | ((
          context: MigrationContext,
        ) => Effect.Effect<ReadonlyArray<MigrationOperation>, MigrationError | SqlError>)
      | undefined;
    if (sameVariant(targetVersion, current)) {
      const list = schemasOfVariant(current);
      const targetIndex = list.findIndex((s) => s.version === targetSchema.version);
      if (list[targetIndex - 1]?.version === currentSchema.version) run = targetSchema.up;
      else if (list[targetIndex + 1]?.version === currentSchema.version) run = targetSchema.down;
    }

    const auto: Effect.Effect<
      ReadonlyArray<MigrationOperation>,
      MigrationError | SqlError,
      R
    > = Effect.gen(function* () {
      let generated: ReadonlyArray<MigrationOperation>;
      if (mode === "from-schema") {
        // Drops are opt-in on this path as well: a startup migration that runs
        // without `unsafe` never destroys a table or a column. `unsafe` only
        // supplies the default, so an adapter that states either setting keeps
        // the value it states.
        generated = fromSchema(currentSchema, targetSchema, {
          ...userConfig,
          dropUnusedColumns: userConfig.dropUnusedColumns ?? unsafe,
          dropUnusedTables: userConfig.dropUnusedTables ?? unsafe,
        });
      } else {
        if (generateMigrationFromDatabase === undefined) {
          return yield* new MigrationError({
            reason: "Unsupported",
            message: `${mode} is not supported for this adapter.`,
          });
        }
        generated = yield* generateMigrationFromDatabase({
          target: targetSchema,
          dropUnusedColumns: unsafe,
        });
      }
      for (const transformer of transformers) {
        if (transformer.afterAuto === undefined) continue;
        generated = transformer.afterAuto(generated, {
          prev: currentSchema,
          next: targetSchema,
          options: migrateOptions,
        });
      }
      return generated;
    });

    // Custom functions are environment-free; hand them an `auto` that already has R provided.
    const context = yield* Effect.context<R>();
    const migrationContext: MigrationContext = { auto: Effect.provideContext(auto, context) };
    let operations: ReadonlyArray<MigrationOperation> =
      run === undefined ? yield* auto : yield* run(migrationContext);

    if (updateSettings) {
      operations = [...operations, ...(yield* settings.updateSettingsInMigration(targetSchema))];
    }
    for (const transformer of transformers) {
      if (transformer.afterAll === undefined) continue;
      operations = transformer.afterAll(operations, { prev: currentSchema, next: targetSchema });
    }

    const sql =
      toSql === undefined
        ? Option.none<string>()
        : Option.some(yield* Effect.fromResult(toSql(operations)));

    const result: MigrationResult<R> = { operations, sql, execute: executor(operations) };
    return result;
  });

  return {
    version: settings.getVersion,
    nameVariants: settings.getNameVariants,
    next,
    previous,
    up: (migrateOptions) =>
      Effect.flatMap(next, (n) =>
        Option.isNone(n)
          ? Effect.fail(
              new MigrationError({ reason: "AlreadyUpToDate", message: "Already up to date." }),
            )
          : migrateTo(n.value.version, migrateOptions),
      ),
    down: (migrateOptions) =>
      Effect.flatMap(previous, (p) =>
        Option.isNone(p)
          ? Effect.fail(
              new MigrationError({
                reason: "NoPrevious",
                message: "No previous schema to migrate to.",
              }),
            )
          : migrateTo(p.value.version, migrateOptions),
      ),
    migrateTo,
    migrateToLatest: (migrateOptions) =>
      Effect.flatMap(currentVersion, (version) => {
        const last = schemasOfVariant(parseOrThrow(version)).at(-1);
        return last === undefined
          ? Effect.fail(
              new MigrationError({
                reason: "UnknownVersion",
                message: "Cannot find other schemas",
              }),
            )
          : migrateTo(last.version, migrateOptions);
      }),
  };
};
