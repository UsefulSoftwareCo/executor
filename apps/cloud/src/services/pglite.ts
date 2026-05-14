import { PGlite } from "@electric-sql/pglite";
import {
  PGLiteSocketServer,
  type PGLiteSocketServer as PgliteSocketServer,
} from "@electric-sql/pglite-socket";
import { drizzle, type PgliteDatabase } from "drizzle-orm/pglite";
import {
  createDrizzleRuntimeSchemaFromTables,
  ensureDrizzleRuntimeSchemaFromTables,
} from "fumadb/adapters/drizzle";

import type { FumaTables } from "@executor-js/sdk";

import { createDrizzleFumaDb, type DrizzleFumaDb } from "./fuma";

export interface PgliteFumaDb<
  TTables extends FumaTables = FumaTables,
> extends DrizzleFumaDb<TTables> {
  readonly drizzle: PgliteDatabase<any>;
  readonly pglite: PGlite;
  readonly server: PgliteSocketServer | null;
  readonly connectionString: string | null;
  readonly close: () => Promise<void>;
}

export interface CreatePgliteFumaDbOptions<TTables extends FumaTables = FumaTables> {
  readonly tables: TTables;
  readonly namespace: string;
  readonly version?: string;
  readonly dataDir?: string;
  readonly host?: string;
  readonly port?: number;
}

export const createPgliteFumaDb = async <const TTables extends FumaTables>(
  options: CreatePgliteFumaDbOptions<TTables>,
): Promise<PgliteFumaDb<TTables>> => {
  const version = options.version ?? "1.0.0";
  const pglite = await PGlite.create(options.dataDir ?? "memory://");
  const schema = createDrizzleRuntimeSchemaFromTables({
    tables: options.tables,
    namespace: options.namespace,
    version,
    provider: "postgresql",
  });
  const drizzleDb = drizzle({
    client: pglite,
    schema,
  });

  await ensureDrizzleRuntimeSchemaFromTables(drizzleDb, {
    tables: options.tables,
    namespace: options.namespace,
    version,
    provider: "postgresql",
  });

  const fuma = createDrizzleFumaDb({
    db: drizzleDb,
    tables: options.tables,
    namespace: options.namespace,
    version,
    provider: "postgresql",
  });

  const server =
    options.host || options.port
      ? new PGLiteSocketServer({
          db: pglite,
          host: options.host,
          port: options.port ?? 0,
        })
      : null;

  await server?.start();

  const connectionString = server
    ? (() => {
        const [host, port] = server.getServerConn().split(":");
        return `postgres://postgres:postgres@${host}:${port}/postgres`;
      })()
    : null;

  return {
    db: fuma.db,
    fuma: fuma.fuma,
    drizzle: drizzleDb,
    pglite,
    server,
    connectionString,
    close: async () => {
      await server?.stop();
      await pglite.close();
    },
  };
};
