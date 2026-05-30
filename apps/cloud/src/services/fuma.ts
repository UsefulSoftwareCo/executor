import { Effect, Layer } from "effect";
import { type FumaDB } from "fumadb";
import { type DrizzleConfig } from "fumadb/adapters/drizzle";
import { type schema as fumaSchema, type RelationsMap } from "fumadb/schema";

import {
  createExecutorFumaDb,
  DbProvider,
  type ExecutorDbHandle,
  type ExecutorDbProvider,
} from "@executor-js/api/server";
import type { FumaDb, FumaTables } from "@executor-js/sdk";

import { DbService } from "./db";

type DrizzleFumaSchema<TTables extends FumaTables> = ReturnType<
  typeof fumaSchema<string, TTables, RelationsMap<TTables>>
>;

export interface DrizzleFumaDb<TTables extends FumaTables = FumaTables> {
  readonly db: FumaDb<DrizzleFumaSchema<TTables>>;
  readonly fuma: FumaDB<DrizzleFumaSchema<TTables>[]>;
}

export interface CreateDrizzleFumaDbOptions<TTables extends FumaTables = FumaTables> {
  readonly db: DrizzleConfig["db"];
  readonly tables: TTables;
  readonly namespace: string;
  readonly version?: string;
  readonly provider: ExecutorDbProvider;
}

// Cloud opens its own postgres-js drizzle handle (see ./db.ts) and runs
// migrations out-of-band, so this is the pure FumaDB assembly over an
// already-opened `db`. Delegates to the shared factory; the local wrapper
// keeps the cloud-specific default version + option names.
export const createDrizzleFumaDb = <const TTables extends FumaTables>(
  options: CreateDrizzleFumaDbOptions<TTables>,
): DrizzleFumaDb<TTables> =>
  createExecutorFumaDb(options.db, {
    tables: options.tables,
    namespace: options.namespace,
    version: options.version ?? "1.0.0",
    provider: options.provider,
  });

export const CLOUD_NAMESPACE = "executor_cloud";

// Shared DbProvider seam (P2a). Cloud opens a fresh postgres-js connection per
// request (Cloudflare forbids sharing I/O across handlers); this assembles the
// FumaDB handle over the request-scoped `DbService.db`. Migrations run
// out-of-band, so there is no schema bring-up here, and `close` is a no-op —
// `DbService.Live` owns the postgres connection lifecycle.
export const cloudDbProviderLayer = (
  tables: FumaTables,
): Layer.Layer<DbProvider, never, DbService> =>
  Layer.effect(DbProvider)(
    Effect.map(DbService.asEffect(), ({ db }): ExecutorDbHandle => {
      const fuma = createDrizzleFumaDb({
        db,
        tables,
        namespace: CLOUD_NAMESPACE,
        provider: "postgresql",
      });
      return {
        db: fuma.db,
        fuma: fuma.fuma,
        close: async () => {},
      };
    }),
  );
