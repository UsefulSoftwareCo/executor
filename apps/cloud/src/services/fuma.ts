import { fumadb, type FumaDB } from "fumadb";
import { drizzleAdapter, type DrizzleConfig } from "fumadb/adapters/drizzle";
import { schema as fumaSchema, type RelationsMap } from "fumadb/schema";

import type { FumaDb, FumaTables } from "@executor-js/sdk";

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
  readonly provider: DrizzleConfig["provider"];
}

export const createDrizzleFumaDb = <const TTables extends FumaTables>(
  options: CreateDrizzleFumaDbOptions<TTables>,
): DrizzleFumaDb<TTables> => {
  const version = options.version ?? "1.0.0";
  const latestSchema = fumaSchema({
    version,
    tables: options.tables,
  });
  const factory = fumadb({
    namespace: options.namespace,
    schemas: [latestSchema],
  });
  const fuma = factory.client(
    drizzleAdapter({
      db: options.db,
      provider: options.provider,
    }),
  );

  return {
    db: fuma.orm(version),
    fuma,
  };
};
