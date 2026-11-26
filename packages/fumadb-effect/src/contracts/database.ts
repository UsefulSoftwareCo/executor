import type { Effect } from "effect";
import type { SqlError } from "effect/sql/SqlError";
import type { SqlClient } from "effect/sql/SqlClient";
import type { Adapter } from "./adapter.ts";
import type { MigrationError, NotInitialized } from "./errors.ts";
import type { Migrator } from "./migration.ts";
import type { Orm } from "./query.ts";
import type { NameVariantsBuilder } from "./names.ts";
import type { AnySchema } from "./schema/schema.ts";

type Last<T extends ReadonlyArray<unknown>> = T extends readonly [...infer _, infer L]
  ? L
  : T[number];

export interface FumaDB<
  Schemas extends ReadonlyArray<AnySchema> = ReadonlyArray<AnySchema>,
  R = never,
> {
  readonly schemas: Schemas;
  readonly adapter: Adapter<R>;
  readonly version: Effect.Effect<Schemas[number]["version"], NotInitialized | SqlError, R>;
  readonly cachedVersion: Effect.Effect<
    Effect.Effect<Schemas[number]["version"], NotInitialized | SqlError, R>
  >;
  readonly orm: <V extends Schemas[number]["version"]>(
    version: V,
  ) => Orm<Extract<Schemas[number], { version: V }>, R>;
  readonly latest: Orm<Last<Schemas>, R>;
  readonly createMigrator: Effect.Effect<Migrator<R>, MigrationError>;
}

export interface FumaDBFactory<Schemas extends ReadonlyArray<AnySchema>> {
  readonly version: <T extends Schemas[number]["version"]>(target: T) => T;
  readonly client: <R>(adapter: Adapter<R>) => FumaDB<Schemas, R>;
  readonly names: NameVariantsBuilder<Schemas, FumaDBFactory<Schemas>>;
}

export type InferFumaDB<Factory, R = SqlClient> =
  Factory extends FumaDBFactory<infer Schemas>
    ? FumaDB<Schemas, R>
    : { readonly "InferFumaDB expects the result of fumadb(...)": Factory };

export type InferOrm<Client, Version extends string> =
  Client extends FumaDB<infer Schemas, infer R>
    ? Orm<Extract<Schemas[number], { version: Version }>, R> & { readonly version: Version }
    : never;
