import { compare } from "semver";
import type { FumaDBAdapter, FumaDBAdapterContext } from "./adapters";
import type { Migrator } from "./migration-engine/create";
import type { AbstractQuery } from "./query";
import type { AnySchema } from "./schema";
import {
  createNameVariantsBuilder,
  type NameVariantsBuilder,
} from "./schema/name-variants-builder";
import type { LibraryConfig } from "./shared/config";

export * from "./shared/config";
export * from "./shared/providers";

type Last<T extends unknown[]> = T extends [...infer _, infer L]
  ? L
  : T[number];

export interface FumaDB<Schemas extends AnySchema[] = AnySchema[]> {
  schemas: Schemas;
  adapter: FumaDBAdapter;

  /**
   * Shorthand for `orm()` latest schema version
   * @deprecated use `orm()` directly
   */
  readonly abstract: AbstractQuery<Last<Schemas>>;

  /**
   * Get current schema version
   */
  version: () => Promise<Schemas[number]["version"]>;

  orm: <V extends Schemas[number]["version"]>(
    version: V
  ) => AbstractQuery<Extract<Schemas[number], { version: V }>>;

  /**
   * Kysely & MongoDB only
   */
  createMigrator: () => Migrator;

  /**
   * ORM only
   */
  generateSchema: (
    version: Schemas[number]["version"] | "latest",
    name?: string
  ) => {
    code: string;
    path: string;
  };
}

export interface FumaDBFactory<Schemas extends AnySchema[]> {
  /**
   * A static type-checker
   */
  version: <T extends Schemas[number]["version"]>(target: T) => T;

  /**
   * Configure consumer-side integration
   */
  client: (adapter: FumaDBAdapter) => FumaDB<Schemas>;

  /**
   * Set name variants
   */
  names: NameVariantsBuilder<Schemas, FumaDBFactory<Schemas>>;
}

export type InferFumaDB<Factory extends FumaDBFactory<any>> =
  Factory extends FumaDBFactory<infer Schemas> ? FumaDB<Schemas> : never;

export type InferAbstractQuery<
  Factory extends FumaDB<any>,
  Version extends string,
> =
  Factory extends FumaDB<infer Schemas>
    ? AbstractQuery<Extract<Schemas[number], { version: Version }>> & {
        version: Version;
      }
    : never;

export function fumadb<Schemas extends AnySchema[]>(
  config: LibraryConfig<Schemas>
): FumaDBFactory<Schemas> {
  const schemas = config.schemas.sort((a, b) => compare(a.version, b.version));
  return {
    names: createNameVariantsBuilder(config.namespace, schemas, (schemas) => {
      return fumadb({
        ...config,
        schemas,
      });
    }),
    version(targetVersion) {
      return targetVersion;
    },

    client(adapter) {
      const orms = new Map<string, AbstractQuery<AnySchema>>();
      const adapterContext: FumaDBAdapterContext = {
        ...config,
      };

      return {
        adapter,
        schemas,
        orm(version) {
          let orm = orms.get(version);
          if (orm) return orm;

          const schema = schemas.find((schema) => schema.version === version);
          if (!schema) throw new Error(`unknown schema version ${version}`);

          orm = adapter.createORM.call(adapterContext, schema);
          orms.set(version, orm);
          return orm as any;
        },
        async version() {
          const version = await adapter.getSchemaVersion.call(adapterContext);
          if (!version)
            throw new Error(`FumaDB ${config.namespace} is not initialized.`);

          return version;
        },
        generateSchema(version, name = config.namespace) {
          if (!adapter.generateSchema)
            throw new Error("The adapter doesn't support schema API.");
          let schema: AnySchema;

          if (version === "latest") {
            schema = schemas.at(-1)!;
          } else {
            schema = schemas.find((schema) => schema.version === version)!;
            if (!schema) throw new Error(`Invalid version: ${version}`);
          }

          return adapter.generateSchema.call(adapterContext, schema, name);
        },

        createMigrator() {
          if (!adapter.createMigrationEngine)
            throw new Error("The adapter doesn't support migration engine.");

          return adapter.createMigrationEngine.call(adapterContext);
        },

        get abstract() {
          return this.orm(schemas.at(-1)!.version) as any;
        },
      };
    },
  };
}
