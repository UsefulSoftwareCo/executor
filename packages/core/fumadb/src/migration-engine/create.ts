import { parse } from "semver";
import { type AnySchema, type NameVariants, schema } from "../schema/create";
import {
  applyNameVariants,
  type NameVariantsConfig,
} from "../schema/name-variants-builder";
import type { LibraryConfig, RelationMode } from "../shared/config";
import type { Provider } from "../shared/providers";
import { deepEqual } from "../utils/deep-equal";
import { generateMigrationFromSchema as defaultGenerateMigrationFromSchema } from "./auto-from-schema";
import type { MigrationOperation } from "./shared";

type Awaitable<T> = T | Promise<T>;

interface MigrationContext {
  auto: () => Promise<MigrationOperation[]>;
}

export type CustomMigrationFn = (
  context: MigrationContext
) => Awaitable<MigrationOperation[]>;

export interface MigrateOptions {
  /**
   * Manage how migrations are generated.
   *
   * - `from-schema` (default): compare fumadb schemas
   * - `from-database`: introspect & compare the database with schema
   */
  mode?: "from-schema" | "from-database";

  /**
   * Update internal settings, it's true by default.
   * We don't recommend to disable it other than testing purposes.
   */
  updateSettings?: boolean;

  /**
   * Enable unsafe operations when auto-generating migration.
   */
  unsafe?: boolean;
}

export interface MigrationResult {
  operations: MigrationOperation[];
  getSQL?: () => string;
  execute: () => Promise<void>;
}

export interface Migrator {
  /**
   * Get current version, undefined if not initialized
   */
  getVersion: () => Promise<string | undefined>;
  getNameVariants: () => Promise<NameVariantsConfig | undefined>;

  next: () => Promise<AnySchema | undefined>;
  previous: () => Promise<AnySchema | undefined>;
  up: (options?: MigrateOptions) => Promise<MigrationResult>;
  down: (options?: MigrateOptions) => Promise<MigrationResult>;
  migrateTo: (
    version: string,
    options?: MigrateOptions
  ) => Promise<MigrationResult>;
  migrateToLatest: (options?: MigrateOptions) => Promise<MigrationResult>;
}

export interface MigrationEngineOptions {
  libConfig: LibraryConfig;
  userConfig: {
    provider: Provider;
    relationMode?: RelationMode;
  };

  executor: (operations: MigrationOperation[]) => Promise<void>;

  generateMigrationFromSchema?: typeof defaultGenerateMigrationFromSchema;

  generateMigrationFromDatabase?: (options: {
    target: AnySchema;
    dropUnusedColumns: boolean;
  }) => Awaitable<MigrationOperation[]>;

  settings: {
    getVersion: () => Promise<string | undefined>;

    /**
     * get name variants for every table and column in schema.
     *
     * this is necessary for migrating database when name variants are changed by consumer,
     * consumer's code doesn't have history like library's schema do, we need to detect it from previous settings.
     */
    getNameVariants(): Promise<Record<string, NameVariants> | undefined>;

    updateSettingsInMigration: (
      schema: AnySchema
    ) => Awaitable<MigrationOperation[]>;
  };

  sql?: {
    toSql: (operations: MigrationOperation[]) => string;
  };

  transformers?: MigrationTransformer[];
}

export interface MigrationTransformer {
  /**
   * Run after auto-generating migration operations
   */
  afterAuto?: (
    operations: MigrationOperation[],
    context: {
      options: MigrateOptions;
      prev: AnySchema;
      next: AnySchema;
    }
  ) => MigrationOperation[];

  /**
   * Run on all migration operations
   */
  afterAll?: (
    operations: MigrationOperation[],
    context: {
      prev: AnySchema;
      next: AnySchema;
    }
  ) => MigrationOperation[];
}

export function createMigrator({
  settings,
  generateMigrationFromDatabase,
  generateMigrationFromSchema = defaultGenerateMigrationFromSchema,
  libConfig: { schemas, initialVersion = "0.0.0" },
  userConfig,
  executor,
  sql: sqlConfig,
  transformers = [],
}: MigrationEngineOptions): Migrator {
  const indexedSchemas = new Map<string, AnySchema>();

  indexedSchemas.set(
    initialVersion,
    schema({
      version: initialVersion,
      tables: {},
    })
  );

  for (const schema of schemas) {
    if (indexedSchemas.has(schema.version))
      throw new Error(`Duplicated version: ${schema.version}`);

    indexedSchemas.set(schema.version, schema);
  }

  function getSchemaByVersion(version: string) {
    const schema = indexedSchemas.get(version);
    if (!schema) throw new Error(`Invalid version ${version}`);
    return schema;
  }

  async function getCurrentSchema() {
    const version = (await settings.getVersion()) ?? initialVersion;
    const nameVariants = await settings.getNameVariants();
    let schema = getSchemaByVersion(version);

    if (nameVariants) schema = applyNameVariants(schema, nameVariants);

    return schema;
  }

  function getSchemasOfVariant(
    variant: readonly (string | number)[]
  ): AnySchema[] {
    return schemas.filter((schema) =>
      deepEqual(parse(schema.version)!.prerelease, variant)
    );
  }

  const instance: Migrator = {
    getVersion() {
      return settings.getVersion();
    },
    getNameVariants() {
      return settings.getNameVariants();
    },
    async next() {
      const version = (await settings.getVersion()) ?? initialVersion;
      const list = getSchemasOfVariant(parse(version)!.prerelease);
      const index = list.findIndex((schema) => schema.version === version);

      return list[index + 1];
    },
    async previous() {
      const version = await settings.getVersion();
      if (!version) return;

      const list = getSchemasOfVariant(parse(version)!.prerelease);
      const index = list.findIndex((schema) => schema.version === version);
      return list[index - 1];
    },
    async up(options = {}) {
      const next = await this.next();
      if (!next) throw new Error("Already up to date.");

      return this.migrateTo(next.version, options);
    },
    async down(options = {}) {
      const prev = await this.previous();
      if (!prev) throw new Error("No previous schema to migrate to.");

      return this.migrateTo(prev.version, options);
    },
    async migrateTo(version, options = {}) {
      const {
        updateSettings: updateVersion = true,
        unsafe = false,
        mode = "from-schema",
      } = options;
      const targetSchema = getSchemaByVersion(version);
      const currentSchema = await getCurrentSchema();

      let run:
        | ((context: MigrationContext) => Awaitable<MigrationOperation[]>)
        | undefined;

      // same variant
      const prevVariant = parse(targetSchema.version)!.prerelease;
      const variant = parse(currentSchema.version)!.prerelease;

      if (deepEqual(prevVariant, variant)) {
        const list = getSchemasOfVariant(variant);
        const targetIdx = list.indexOf(targetSchema);

        switch (currentSchema.version) {
          case list[targetIdx - 1]?.version:
            run = targetSchema.up;
            break;
          case list[targetIdx + 1]?.version:
            run = targetSchema.down;
            break;
        }
      }

      run ??= (context) => context.auto();

      const context: MigrationContext = {
        async auto() {
          let generated: MigrationOperation[];

          if (mode === "from-schema") {
            generated = generateMigrationFromSchema(
              currentSchema,
              targetSchema,
              userConfig
            );
          } else {
            if (!generateMigrationFromDatabase)
              throw new Error(`${mode} is not supported for this adapter.`);

            generated = await generateMigrationFromDatabase({
              target: targetSchema,
              dropUnusedColumns: unsafe,
            });
          }

          for (const transformer of transformers) {
            if (!transformer.afterAuto) continue;

            generated = transformer.afterAuto(generated, {
              prev: currentSchema,
              next: targetSchema,
              options,
            });
          }

          return generated;
        },
      };

      let operations = await run(context);

      if (updateVersion) {
        operations.push(
          ...(await settings.updateSettingsInMigration(targetSchema))
        );
      }

      for (const transformer of transformers) {
        if (!transformer.afterAll) continue;
        operations = transformer.afterAll(operations, {
          prev: currentSchema,
          next: targetSchema,
        });
      }

      return {
        operations,
        getSQL: sqlConfig ? () => sqlConfig.toSql(operations) : undefined,
        execute: () => executor(operations),
      };
    },
    async migrateToLatest(options) {
      const version = (await settings.getVersion()) ?? initialVersion;
      const last = getSchemasOfVariant(parse(version)!.prerelease).at(-1);
      if (!last) throw new Error(`Cannot find other schemas`);

      return this.migrateTo(last.version, options);
    },
  };

  return instance;
}
