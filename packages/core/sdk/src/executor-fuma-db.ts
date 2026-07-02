// ---------------------------------------------------------------------------
// Shared FumaDB assembly (pure, driver-agnostic).
//
// Every host (self-host, local, sdk-test, cloud) historically hand-rolled the
// same driver-agnostic FumaDB wiring: build a fumadb factory from the latest
// schema, bind it to an already-opened drizzle handle through `drizzleAdapter`,
// and expose `{ db: fuma.orm(version), fuma }`. `createExecutorFumaDb` owns ONLY
// that assembly — the caller still opens its own driver (libSQL for SQLite,
// postgres-js for Postgres), applies its own PRAGMAs, and runs its own schema
// bring-up. The factory is dialect-generic via the `provider` param.
//
// This is a pure helper, not the `DbProvider` Effect seam. The seam
// (`DbProvider` / `dbProviderLayer`) is host-composition and lives in the host
// layer (`@executor-js/api/server`). This assembly stays in the SDK because the
// SDK's own sqlite test backend (`sqlite-test-db.ts`) builds its handle with it;
// hosts reach it (and the seam) through `@executor-js/api/server`, which
// re-exports `createExecutorFumaDb` from here. It is NOT on the plugin-author
// root barrel — host code imports it from `@executor-js/sdk/host-internal`.
// ---------------------------------------------------------------------------

import { fumadb, type FumaDB } from "@executor-js/fumadb";
import { type DrizzleRuntimeProvider } from "@executor-js/fumadb/adapters/drizzle";
import { drizzleAdapter } from "@executor-js/fumadb/adapters/drizzle";
import { schema as fumaSchema, type RelationsMap } from "@executor-js/fumadb/schema";

import type { BlobStore } from "./blob";
import type { FumaDb, FumaTables } from "./fuma-runtime";

// The FumaDB provider both the runtime-schema generator and the drizzle adapter
// understand. SQLite (libSQL) and PostgreSQL (postgres-js) are the only
// dialects in use today.
export type ExecutorDbProvider = DrizzleRuntimeProvider;

export type ExecutorFumaSchema<TTables extends FumaTables> = ReturnType<
  typeof fumaSchema<string, TTables, RelationsMap<TTables>>
>;

export interface ExecutorFumaDb<TTables extends FumaTables = FumaTables> {
  readonly db: FumaDb<ExecutorFumaSchema<TTables>>;
  readonly fuma: FumaDB<ExecutorFumaSchema<TTables>[]>;
}

export interface CreateExecutorFumaDbOptions<TTables extends FumaTables = FumaTables> {
  readonly tables: TTables;
  readonly namespace: string;
  readonly version: string;
  readonly provider: ExecutorDbProvider;
  /**
   * Whether the engine supports interactive transactions (BEGIN/COMMIT).
   * Defaults to `true`. Cloudflare D1 must pass `false` — it rejects
   * interactive transactions, so the adapter runs transaction callbacks
   * directly (auto-commit per statement). libSQL/Postgres keep real
   * transactions.
   */
  readonly interactiveTransactions?: boolean;
  /**
   * Maximum bound parameters per query (Cloudflare D1: 100). When set,
   * `createMany` batches so `rows * columns` stays within it. Unset for
   * libSQL/Postgres (no tight cap).
   */
  readonly maxBoundParameters?: number;
}

/**
 * Driver-agnostic FumaDB assembly. The caller passes an already-opened drizzle
 * handle (it owns the driver, PRAGMAs, and schema bring-up); this wires the
 * fumadb client over it and returns the `{ db, fuma }` query surface.
 *
 * NOTE: the drizzle `db` must already have its runtime schema attached (via
 * `createDrizzleRuntimeSchemaFromTables`) for SQLite/Postgres relational
 * queries to resolve — that schema generation stays caller-side because it is
 * coupled to the caller's drizzle() construction.
 */
export const createExecutorFumaDb = <const TTables extends FumaTables>(
  drizzleDb: unknown,
  options: CreateExecutorFumaDbOptions<TTables>,
): ExecutorFumaDb<TTables> => {
  const latestSchema = fumaSchema({
    version: options.version,
    tables: options.tables,
  });
  const factory = fumadb({
    namespace: options.namespace,
    schemas: [latestSchema],
  });
  const fuma = factory.client(
    drizzleAdapter({
      db: drizzleDb,
      provider: options.provider,
      interactiveTransactions: options.interactiveTransactions,
      maxBoundParameters: options.maxBoundParameters,
    }),
  );

  return {
    db: fuma.orm(options.version),
    fuma,
  };
};

// The uniform handle each host exposes through the `DbProvider` Layer (defined
// in the host layer). The `db`/`fuma` come from `createExecutorFumaDb`; `close`
// releases the host's own driver. Hosts that keep extra connection objects (the
// raw sqlite handle, the postgres `sql`) layer those into their own concrete
// handle type and still satisfy this contract.
export interface ExecutorDbHandle<
  TTables extends FumaTables = FumaTables,
> extends ExecutorFumaDb<TTables> {
  readonly close: () => Promise<void>;
  /**
   * Optional blob backend assembled alongside the driver (an R2 bucket on the
   * Cloudflare hosts). `makeScopedExecutor` threads it into
   * `createExecutor({ blobs })`; absent, the executor defaults to the FumaDB
   * `blob` table over `db`.
   */
  readonly blobs?: BlobStore;
}
