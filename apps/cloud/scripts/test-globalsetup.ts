// ---------------------------------------------------------------------------
// Vitest globalSetup — starts an in-process PGlite socket server so tests
// running in the Cloudflare Workers runtime can connect to a real Postgres
// via postgres.js. Port must match DATABASE_URL in vitest.config.ts.
// ---------------------------------------------------------------------------

import { PGlite } from "@electric-sql/pglite";
import { PGLiteSocketServer } from "@electric-sql/pglite-socket";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

// 0 asks the OS for a free port — used by the globalsetup-exit fixture, whose
// test never connects to the database. A suite whose tests DO connect (the
// default 5434 path, matched by DATABASE_URL in vitest.config.ts) must pass a
// real port. Fixed ports must stay below 32768: the Linux ephemeral range
// (32768-60999) is contested by every concurrent suite's outbound sockets.
const parsePort = (input: string | undefined): number => {
  if (input === undefined) return 5434;
  if (!/^\d+$/.test(input)) throw new Error("CLOUD_TEST_DB_PORT must be an integer");
  const port = Number(input);
  if (!Number.isSafeInteger(port) || port > 65_535) {
    throw new Error("CLOUD_TEST_DB_PORT must be between 0 and 65535");
  }
  return port;
};

const PORT = parsePort(process.env.CLOUD_TEST_DB_PORT);
const MIGRATIONS_FOLDER = resolve(__dirname, "../drizzle");

let db: PGlite | undefined;
let server: PGLiteSocketServer | undefined;

/**
 * Starts the cloud unit-test database and returns teardown that releases every
 * resource without allowing PGlite shutdown to erase Vitest's failure status.
 */
export default async function setup() {
  db = await PGlite.create();
  await migrate(drizzle(db), { migrationsFolder: MIGRATIONS_FOLDER });

  server = new PGLiteSocketServer({ db, port: PORT, host: "127.0.0.1" });
  await server.start();

  // eslint-disable-next-line no-console
  console.log(`[test-db] PGlite socket server listening on 127.0.0.1:${PORT}`);

  return async () => {
    // PGlite sets an internal 99 sentinel on startup and replaces it with 0 on
    // close. Preserve Vitest's failure status across that close so
    // teardown can turn neither a red test green nor a green test red.
    const testsFailed = process.exitCode === 1;
    await server?.stop();
    await db?.close();
    if (testsFailed) process.exitCode = 1;
  };
}
