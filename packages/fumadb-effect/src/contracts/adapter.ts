/**
 * The adapter contract.
 *
 * An adapter binds FumaDB to one storage technology. This package ships the
 * SQL adapter (`fumadb-effect/sql`) built on Effect SQL. `R` is the environment
 * an adapter's operations need; consumers provide it with a `Layer`.
 */
import type { Effect, Option } from "effect";
import type { SqlError } from "effect/unstable/sql/SqlError";
import type { Migrator } from "./migration.ts";
import type { Orm } from "./query.ts";
import type { AnySchema } from "./schema/schema.ts";

/** Library-level configuration, as passed to `fumadb(...)`. */
export interface LibraryConfig<
  Schemas extends ReadonlyArray<AnySchema> = ReadonlyArray<AnySchema>,
> {
  /** Stable identifier for this library. Must never change once published. */
  readonly namespace: string;
  /** Every schema version, in any order. */
  readonly schemas: Schemas;
  /**
   * The version of a database before it is initialised. Do not use it for a schema.
   * @default "0.0.0"
   */
  readonly initialVersion?: string | undefined;
}

/** What an adapter receives on every call: the library configuration, with schemas sorted by version. */
export interface AdapterContext extends LibraryConfig {}

/**
 * Binds FumaDB to one storage technology. `R` is the environment the
 * adapter's effects need; consumers provide it with a `Layer`.
 */
export interface Adapter<R> {
  readonly name: string;
  /** Build the query interface for one schema version. */
  readonly createOrm: (context: AdapterContext, schema: AnySchema) => Orm<AnySchema, R>;
  /** The schema version currently applied, or `None` before initialisation. */
  readonly getSchemaVersion: (
    context: AdapterContext,
  ) => Effect.Effect<Option.Option<string>, SqlError, R>;
  /** Build the migrator, when the adapter supports migrations. */
  readonly createMigrator: ((context: AdapterContext) => Migrator<R>) | undefined;
}
