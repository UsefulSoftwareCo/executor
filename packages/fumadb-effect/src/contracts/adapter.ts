import type { Effect, Option } from "effect";
import type { SqlError } from "effect/sql/SqlError";
import type { Migrator } from "./migration.ts";
import type { Orm } from "./query.ts";
import type { AnySchema } from "./schema/schema.ts";

export interface LibraryConfig<
  Schemas extends ReadonlyArray<AnySchema> = ReadonlyArray<AnySchema>,
> {
  readonly namespace: string;
  readonly schemas: Schemas;
  readonly initialVersion?: string | undefined;
}

export interface AdapterContext extends LibraryConfig {}

export interface Adapter<R> {
  readonly name: string;
  readonly createOrm: (context: AdapterContext, schema: AnySchema) => Orm<AnySchema, R>;
  readonly getSchemaVersion: (
    context: AdapterContext,
  ) => Effect.Effect<Option.Option<string>, SqlError, R>;
  readonly createMigrator: ((context: AdapterContext) => Migrator<R>) | undefined;
}
