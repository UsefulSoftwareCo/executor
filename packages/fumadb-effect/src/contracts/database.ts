/** Database factory, client, and schema inference contracts. */
import type { Effect } from "effect";
import type { SqlError } from "effect/unstable/sql/SqlError";
import type { SqlClient } from "effect/unstable/sql/SqlClient";
import type { Adapter } from "./adapter.ts";
import type { MigrationError, NotInitialized } from "./errors.ts";
import type { Migrator } from "./migration.ts";
import type { Orm } from "./query.ts";
import type { NameVariantsBuilder } from "./names.ts";
import type { AnySchema } from "./schema/schema.ts";

type Last<T extends ReadonlyArray<unknown>> = T extends readonly [...infer _, infer L]
  ? L
  : T[number];

/** A configured client: the factory bound to an adapter. */
export interface FumaDB<
  Schemas extends ReadonlyArray<AnySchema> = ReadonlyArray<AnySchema>,
  R = never,
> {
  readonly schemas: Schemas;
  readonly adapter: Adapter<R>;
  /**
   * The schema version applied to the database. Queries the settings table
   * every time; use {@link FumaDB.cachedVersion} inside a long-lived program.
   */
  readonly version: Effect.Effect<Schemas[number]["version"], NotInitialized | SqlError, R>;
  /**
   * A memoised {@link FumaDB.version}: the returned effect reads the database
   * once and replays the result. Build it once per program (for example in a
   * layer) and reuse it; build a fresh one after running a migration.
   */
  readonly cachedVersion: Effect.Effect<
    Effect.Effect<Schemas[number]["version"], NotInitialized | SqlError, R>
  >;
  /** The query interface for a schema version. */
  readonly orm: <V extends Schemas[number]["version"]>(
    version: V,
  ) => Orm<Extract<Schemas[number], { version: V }>, R>;
  /** Shorthand for `orm(<latest version>)`. */
  readonly latest: Orm<Last<Schemas>, R>;
  /** The migrator. Fails when the adapter does not support migrations. */
  readonly createMigrator: Effect.Effect<Migrator<R>, MigrationError>;
}

/** What `fumadb()` returns: a library's database, before an adapter is bound. */
export interface FumaDBFactory<Schemas extends ReadonlyArray<AnySchema>> {
  /** A static type check for a version literal. */
  readonly version: <T extends Schemas[number]["version"]>(target: T) => T;
  /** Bind an adapter (consumer side). */
  readonly client: <R>(adapter: Adapter<R>) => FumaDB<Schemas, R>;
  /** Override table and column names (consumer side). */
  readonly names: NameVariantsBuilder<Schemas, FumaDBFactory<Schemas>>;
}

/**
 * The client type a library receives, from the type of its factory.
 *
 * `R` is the environment the consumer's adapter needs; it defaults to the SQL
 * adapter's `SqlClient`. `Factory` is deliberately unconstrained: `Orm` is
 * invariant in its schema, so a factory over concrete schema types is not
 * assignable to one over `AnySchema`.
 */
export type InferFumaDB<Factory, R = SqlClient> =
  Factory extends FumaDBFactory<infer Schemas>
    ? FumaDB<Schemas, R>
    : { readonly "InferFumaDB expects the result of fumadb(...)": Factory };

/** The ORM type of one schema version of a client, tagged with that version. */
export type InferOrm<Client, Version extends string> =
  Client extends FumaDB<infer Schemas, infer R>
    ? Orm<Extract<Schemas[number], { version: Version }>, R> & { readonly version: Version }
    : never;
