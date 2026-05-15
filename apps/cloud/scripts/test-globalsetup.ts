// ---------------------------------------------------------------------------
// Vitest globalSetup — starts an in-process PGlite socket server so tests
// running in the Cloudflare Workers runtime can connect to a real Postgres
// via postgres.js. Port must match DATABASE_URL in wrangler.test.jsonc.
// ---------------------------------------------------------------------------

import { PGlite } from "@electric-sql/pglite";
import { PGLiteSocketServer } from "@electric-sql/pglite-socket";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

const PORT = 5434;
const MIGRATIONS_FOLDER = resolve(__dirname, "../drizzle");

let db: PGlite | undefined;
let server: PGLiteSocketServer | undefined;

export default async function setup() {
  db = await PGlite.create();
  await migrate(drizzle(db), { migrationsFolder: MIGRATIONS_FOLDER });

  server = new PGLiteSocketServer({ db, port: PORT, host: "127.0.0.1" });
  await server.start();

  // eslint-disable-next-line no-console
  console.log(`[test-db] PGlite socket server listening on 127.0.0.1:${PORT}`);

  return async () => {
    await server?.stop();
    await db?.close();
  };
}
