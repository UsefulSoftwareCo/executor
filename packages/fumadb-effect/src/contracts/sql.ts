/**
 * Configuration of the SQL adapter.
 */
import type { Provider, RelationMode } from "./provider.ts";

/** Options of `sqlAdapter`. */
export interface SqlAdapterConfig {
  /** Which database the `SqlClient` in the environment talks to. */
  readonly provider: Provider;
  /**
   * How relations are enforced.
   *
   * - `foreign-keys`: real database foreign keys (default).
   * - `fumadb`: FumaDB's own foreign key engine (default and required on MSSQL).
   */
  readonly relationMode?: RelationMode | undefined;
}

/** `SqlAdapterConfig` with defaults applied. */
export interface ResolvedSqlAdapterConfig {
  readonly provider: Provider;
  readonly relationMode: RelationMode;
}
