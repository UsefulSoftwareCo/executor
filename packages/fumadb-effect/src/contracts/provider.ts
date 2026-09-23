/**
 * The SQL providers this package can target.
 *
 * `cockroachdb` speaks the PostgreSQL protocol and shares its Effect dialect,
 * but differs in DDL details (index drops, foreign keys on create), so it stays
 * a distinct provider like upstream fumadb.
 */
import type { Statement } from "effect/unstable/sql";

/** Every provider the SQL adapter supports, in a stable order. */
export const providers = ["postgresql", "cockroachdb", "mysql", "sqlite", "mssql"] as const;

/** A supported SQL provider. */
export type Provider = (typeof providers)[number];

/** Whether a value names a supported provider. */
export const isProvider = (value: unknown): value is Provider =>
  typeof value === "string" && (providers as ReadonlyArray<string>).includes(value);

/** The Effect SQL `Statement.Dialect` a provider compiles through. */
export const dialectOf = (provider: Provider): Statement.Dialect => {
  switch (provider) {
    case "postgresql":
    case "cockroachdb":
      return "pg";
    case "mysql":
      return "mysql";
    case "sqlite":
      return "sqlite";
    case "mssql":
      return "mssql";
  }
};

/**
 * How relations are enforced.
 *
 * - `foreign-keys`: real database foreign keys.
 * - `fumadb`: FumaDB checks and cascades in application code (required for MSSQL,
 *   whose foreign keys cannot target filtered unique indexes).
 */
export type RelationMode = "foreign-keys" | "fumadb";

/** The relation mode a provider uses when none is configured: `fumadb` on MSSQL, real foreign keys elsewhere. */
export const defaultRelationMode = (provider: Provider): RelationMode =>
  provider === "mssql" ? "fumadb" : "foreign-keys";
