// ---------------------------------------------------------------------------
// Local dev Postgres via PGlite — no Docker, no install
// ---------------------------------------------------------------------------
//
// Exposes an in-process PGlite instance over a TCP socket so Hyperdrive's
// localConnectionString can connect to it like a real Postgres server.
// Runs drizzle migrations on startup so the schema is ready.

import { PGlite } from "@electric-sql/pglite";
import { PGLiteSocketServer } from "@electric-sql/pglite-socket";
import { execSync } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = 5433;
const DB_PATH = resolve(__dirname, "../.dev-db");
const MIGRATIONS_FOLDER = resolve(__dirname, "../drizzle");

// Reap any orphan dev-db from a previous `bun dev` that didn't shut down
// cleanly — otherwise the new instance can't bind to PORT and the app ends
// up talking to a stale PGlite with the wrong schema.
function reapStaleDevDb() {
  const out = execSync(`lsof -ti tcp:${PORT} -sTCP:LISTEN 2>/dev/null || true`, {
    encoding: "utf8",
  });
  const pids = out.trim().split("\n").filter(Boolean);
  if (pids.length === 0) return false;

  for (const pid of pids) {
    const cmd = execSync(`ps -p ${pid} -o args= 2>/dev/null || true`, {
      encoding: "utf8",
    }).trim();
    if (!cmd.includes("dev-db.ts")) {
      console.error(`[dev-db] Port ${PORT} is held by an unexpected process (pid ${pid}): ${cmd}`);
      console.error(`[dev-db] Refusing to kill it. Free the port and retry.`);
      process.exit(1);
    }
    console.log(`[dev-db] Reaping stale dev-db (pid ${pid})`);
    execSync(`kill -KILL ${pid}`);
  }
  return true;
}

if (reapStaleDevDb()) {
  // Give the kernel a beat to release the socket before we try to bind.
  await sleep(200);
}

console.log(`[dev-db] Starting PGlite at ${DB_PATH}`);
const db = await PGlite.create(DB_PATH);

console.log(`[dev-db] Running migrations from ${MIGRATIONS_FOLDER}`);
await migrate(drizzle(db), { migrationsFolder: MIGRATIONS_FOLDER });

const server = new PGLiteSocketServer({
  db,
  port: PORT,
  host: "127.0.0.1",
});

await server.start();
console.log(`[dev-db] Listening on postgresql://postgres:postgres@127.0.0.1:${PORT}/postgres`);

const shutdown = async () => {
  console.log("\n[dev-db] Shutting down");
  await server.stop();
  await db.close();
  process.exit(0);
};

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
