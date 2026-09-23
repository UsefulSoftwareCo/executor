/**
 * fumadb-effect: a unified schema, query, and migration layer for library
 * authors, built on Effect v4 and Effect SQL.
 *
 * ```ts
 * const ChatDB = fumadb({ namespace: "fuma-chat", schemas: [v1] })
 * const client = ChatDB.client(sqlAdapter({ provider: "postgresql" }))
 * const orm = client.orm("1.0.0")
 * ```
 */
import { Effect, Option } from "effect";
import type { Adapter, AdapterContext, LibraryConfig } from "../contracts/adapter.ts";
import { MigrationError, NotInitialized, SchemaDefinitionError } from "../contracts/errors.ts";
import type { Orm } from "../contracts/query.ts";
import { createNameVariantsBuilder } from "../contracts/names.ts";
import type { AnySchema } from "../contracts/schema/schema.ts";
import { compareRaw } from "../contracts/version.ts";
import type { FumaDB, FumaDBFactory } from "../contracts/database.ts";

/** Create the factory for a library's database. */
export const fumadb = <const Schemas extends ReadonlyArray<AnySchema>>(
  config: LibraryConfig<Schemas>,
): FumaDBFactory<Schemas> => {
  const schemas = [...config.schemas].sort((a, b) =>
    compareRaw(a.version, b.version),
  ) as unknown as Schemas;
  if (schemas.length === 0)
    throw new SchemaDefinitionError("fumadb() requires at least one schema.");
  const initialVersion = config.initialVersion ?? "0.0.0";
  const seen = new Set<string>();
  for (const s of schemas) {
    if (s.version === initialVersion) {
      throw new SchemaDefinitionError(
        `Schema version ${s.version} is the initial version and cannot be used for a schema.`,
      );
    }
    if (seen.has(s.version))
      throw new SchemaDefinitionError(`Duplicated schema version: ${s.version}`);
    seen.add(s.version);
  }
  return {
    names: createNameVariantsBuilder(config.namespace, schemas, (updated) =>
      fumadb({ ...config, schemas: updated }),
    ),
    version: (target) => target,
    client: <R>(adapter: Adapter<R>): FumaDB<Schemas, R> => {
      const orms = new Map<string, Orm<AnySchema, R>>();
      const context: AdapterContext = { ...config, schemas };
      const orm = (version: string): Orm<AnySchema, R> => {
        const cached = orms.get(version);
        if (cached !== undefined) return cached;
        const found = schemas.find((s) => s.version === version);
        if (found === undefined)
          throw new SchemaDefinitionError(`unknown schema version ${version}`);
        const created = adapter.createOrm(context, found);
        orms.set(version, created);
        return created;
      };
      const latestSchema = schemas.at(-1);
      if (latestSchema === undefined)
        throw new SchemaDefinitionError("fumadb() requires at least one schema.");
      const { createMigrator } = adapter;
      const version: FumaDB<Schemas, R>["version"] = Effect.flatMap(
        adapter.getSchemaVersion(context),
        (stored) =>
          Option.match(stored, {
            onNone: () => Effect.fail(new NotInitialized({ namespace: config.namespace })),
            onSome: (v) => Effect.succeed(v as Schemas[number]["version"]),
          }),
      );
      return {
        adapter,
        schemas,
        orm: orm as unknown as FumaDB<Schemas, R>["orm"],
        get latest() {
          return orm(latestSchema.version) as unknown as FumaDB<Schemas, R>["latest"];
        },
        version,
        cachedVersion: Effect.cached(version),
        createMigrator:
          createMigrator === undefined
            ? Effect.fail(
                new MigrationError({
                  reason: "Unsupported",
                  message: "The adapter doesn't support migrations.",
                }),
              )
            : Effect.sync(() => createMigrator(context)),
      };
    },
  };
};
