import { PGlite } from "@electric-sql/pglite";
import {
  PGLiteSocketServer,
  type PGLiteSocketServer as PgliteSocketServer,
} from "@electric-sql/pglite-socket";
import { drizzle, type PgliteDatabase } from "drizzle-orm/pglite";
import {
  createDrizzleRuntimeSchemaFromTables,
  ensureDrizzleRuntimeSchemaFromTables,
} from "@executor-js/fumadb/adapters/drizzle";

import type { FumaTables } from "@executor-js/sdk";

export interface PgliteRuntime {
  readonly drizzle: PgliteDatabase<any>;
  readonly pglite: PGlite;
  readonly server: PgliteSocketServer;
  readonly close: () => Promise<void>;
}

export const createPgliteRuntime = async (options: {
  readonly tables: FumaTables;
  readonly namespace: string;
  readonly host: string;
  readonly port: number;
}): Promise<PgliteRuntime> => {
  const pglite = await PGlite.create("memory://");
  const schema = createDrizzleRuntimeSchemaFromTables({
    tables: options.tables,
    namespace: options.namespace,
    version: "1.0.0",
    provider: "postgresql",
  });
  const drizzleDb = drizzle({
    client: pglite,
    schema,
  });
  await ensureDrizzleRuntimeSchemaFromTables(drizzleDb, {
    tables: options.tables,
    namespace: options.namespace,
    version: "1.0.0",
    provider: "postgresql",
  });
  const server = new PGLiteSocketServer({
    db: pglite,
    host: options.host,
    port: options.port,
  });
  await server.start();

  return {
    drizzle: drizzleDb,
    pglite,
    server,
    close: async () => {
      await server.stop();
      await pglite.close();
    },
  };
};
