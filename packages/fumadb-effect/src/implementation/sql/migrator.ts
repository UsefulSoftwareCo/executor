import { Effect, Option, Schema } from "effect";
import { SqlClient } from "effect/sql";
import type { SqlError } from "effect/sql/SqlError";
import type { AdapterContext } from "../../contracts/adapter.ts";
import { MigrationError } from "../../contracts/errors.ts";
import { createMigrator } from "../migration/migrator.ts";
import type { Migrator } from "../../contracts/migration.ts";
import type { MigrationOperation } from "../../contracts/migration-operation.ts";
import { exportNameVariants, NameVariantsConfig } from "../../contracts/schema/names.ts";
import type { AnySchema } from "../../contracts/schema/schema.ts";
import type { ResolvedSqlAdapterConfig } from "../../contracts/sql.ts";
import { renderScript, renderStatements } from "./ddl.ts";
import { generateMigrationFromDatabase } from "./introspect.ts";
import {
  createSettingsTableStatement,
  getSetting,
  getSettingsVersion,
  insertSettingStatement,
  settingsTableExists,
  settingsTableName,
  updateSettingStatement,
} from "./settings.ts";
import { sqliteTransformer } from "./sqlite-transformer.ts";

const parseNameVariants = Schema.decodeUnknownOption(Schema.fromJsonString(NameVariantsConfig));

export const createSqlMigrator = (
  context: AdapterContext,
  config: ResolvedSqlAdapterConfig,
): Migrator<SqlClient.SqlClient> => {
  const { provider, relationMode } = config;
  const table = settingsTableName(context.namespace);

  const preprocess = (
    operations: ReadonlyArray<MigrationOperation>,
  ): ReadonlyArray<MigrationOperation> => {
    switch (provider) {
      case "mysql":
        return [
          { type: "custom", sql: "SET FOREIGN_KEY_CHECKS = 0" },
          ...operations,
          { type: "custom", sql: "SET FOREIGN_KEY_CHECKS = 1" },
        ];
      case "sqlite":
        return [{ type: "custom", sql: "PRAGMA defer_foreign_keys = ON" }, ...operations];
      default:
        return operations;
    }
  };

  const executor = Effect.fn("FumaDB.SqlMigrator.execute")(function* (
    operations: ReadonlyArray<MigrationOperation>,
  ): Effect.fn.Return<void, MigrationError | SqlError, SqlClient.SqlClient> {
    const sql = yield* SqlClient.SqlClient;
    const statements = yield* Effect.fromResult(renderStatements(preprocess(operations), config));
    yield* sql.withTransaction(
      Effect.forEach(
        statements,
        (statement) =>
          Effect.mapError(
            sql.unsafe<Record<string, unknown>>(statement).unprepared,
            (cause) =>
              new MigrationError({
                reason: "Execution",
                message: `Failed to execute migration statement: ${statement}`,
                statement,
                cause,
              }),
          ),
        { discard: true },
      ),
    );
  });

  const getNameVariants: Effect.Effect<
    Option.Option<NameVariantsConfig>,
    SqlError,
    SqlClient.SqlClient
  > = Effect.flatMap(getSetting(provider, table, "name-variants"), (stored) => {
    if (Option.isNone(stored)) return Effect.succeed(Option.none<NameVariantsConfig>());
    const parsed = parseNameVariants(stored.value);
    return Option.isNone(parsed)
      ? Effect.as(
          Effect.logWarning("fumadb: stored name variants are invalid; ignoring them"),
          parsed,
        )
      : Effect.succeed(parsed);
  });

  const updateSettingsInMigration = Effect.fnUntraced(function* (
    schema: AnySchema,
  ): Effect.fn.Return<ReadonlyArray<MigrationOperation>, SqlError, SqlClient.SqlClient> {
    const created = !(yield* settingsTableExists(provider, table));
    const statements: Array<string> = [];
    if (created) statements.push(createSettingsTableStatement(provider, table));

    const entries: ReadonlyArray<readonly [string, string]> = [
      ["version", schema.version],
      ["name-variants", JSON.stringify(exportNameVariants(schema))],
    ];
    for (const [key, value] of entries) {
      const existing = created ? Option.none<string>() : yield* getSetting(provider, table, key);
      statements.push(
        created || Option.isNone(existing)
          ? insertSettingStatement(provider, table, key, value)
          : updateSettingStatement(provider, table, key, value),
      );
    }
    return statements.map((sql): MigrationOperation => ({ type: "custom", sql }));
  });

  return createMigrator<SqlClient.SqlClient>({
    libConfig: context,
    userConfig: { provider, relationMode },
    executor,
    generateMigrationFromDatabase: (options) =>
      Effect.flatMap(getNameVariants, (variants) =>
        generateMigrationFromDatabase(options.target, config, {
          nameVariants: Option.getOrUndefined(variants),
          dropUnusedColumns: options.dropUnusedColumns,
          internalTables: [table],
        }),
      ),
    settings: {
      getVersion: getSettingsVersion(provider, table),
      getNameVariants,
      updateSettingsInMigration,
    },
    toSql: (operations) => renderScript(preprocess(operations), config),
    transformers: provider === "sqlite" ? [sqliteTransformer] : [],
  });
};
