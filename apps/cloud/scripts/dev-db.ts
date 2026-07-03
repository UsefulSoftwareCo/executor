// ---------------------------------------------------------------------------
// Local dev Postgres via PGlite — no Docker, no install
// ---------------------------------------------------------------------------
//
// Exposes an in-process PGlite instance over a TCP socket so Hyperdrive's
// localConnectionString can connect to it like a real Postgres server.
// Runs Drizzle migrations on startup so the schema matches cloud production.

import { execSync } from "node:child_process";
import { existsSync, rmSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { PGLiteSocketServer } from "@electric-sql/pglite-socket";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";

const __dirname = dirname(fileURLToPath(import.meta.url));
// Port + data dir default to the dev values but are env-overridable so a second
// throwaway instance (e.g. the Playwright e2e harness) can run alongside `bun dev`.
const PORT = Number(process.env.DEV_DB_PORT ?? 5433);
const DB_PATH = process.env.DEV_DB_PATH
  ? resolve(process.env.DEV_DB_PATH)
  : resolve(__dirname, "../.dev-db");
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

async function hasDrizzleMigrationHistory(path: string): Promise<boolean> {
  if (!existsSync(path)) return true;

  const db = await PGlite.create(path);
  const result = await db.query<{ exists: boolean }>(`
    SELECT EXISTS (
      SELECT 1
      FROM information_schema.tables
      WHERE table_schema = 'drizzle'
        AND table_name = '__drizzle_migrations'
    ) AS "exists"
  `);
  await db.close();
  return result.rows[0]?.exists === true;
}

if (!(await hasDrizzleMigrationHistory(DB_PATH))) {
  console.log("[dev-db] Resetting dev database without Drizzle migration history");
  rmSync(DB_PATH, { recursive: true, force: true });
}

console.log(`[dev-db] Starting PGlite at ${DB_PATH}`);
const db = await PGlite.create(DB_PATH);

console.log(`[dev-db] Running migrations from ${MIGRATIONS_FOLDER}`);
await migrate(drizzle(db), { migrationsFolder: MIGRATIONS_FOLDER });

// `PGLiteSocketServer` defaults to `maxConnections: 1` and answers every extra
// concurrent connection with "Too many connections" + an immediate socket
// close. (pglite-socket 0.1.4's published index.d.ts documents "default: 100",
// but the shipped runtime JS is `maxConnections ?? 1`, verified in the shipped
// chunk, so the runtime default really is 1.) The cloud worker opens a fresh
// postgres pool per request (the MCP auth seam rebuilds one on EVERY `/mcp`
// request, see apps/cloud/src/mcp/auth.ts), so under concurrent load, exactly
// what the e2e suite generates against one shared dev stack, the
// second-and-later connects were rejected, and postgres.js reconnected in a
// tight loop against the closed socket. That reconnect storm piled up
// thousands of half-closed sockets, starved real queries, drove request
// latency into the tens of seconds, and eventually hung the stack: the CI e2e
// "cloud dev stack degrades after minutes of sustained load" cascade flake.
// PGlite runs queries serially (its internal QueryQueueManager executes each
// under `runExclusive`), so allowing many connections means they queue instead
// of being rejected. One caveat makes that safe: stock pglite-socket 0.1.4
// enqueues each wire FRAME separately, so two connections' extended-protocol
// pipelines (Parse/Bind/Execute/Sync) would interleave inside the one shared
// PGlite session and corrupt each other ("bind message supplies N parameters,
// but prepared statement requires M" -> random 500s on whichever request lost
// the race). The patch in patches/@electric-sql%2Fpglite-socket@0.1.4.patch
// batches each socket data event into one queue entry and holds handler
// affinity while a pipeline is open;
// src/db/dev-db-socket-concurrency.node.test.ts is the regression test.
const server = new PGLiteSocketServer({
  db,
  port: PORT,
  host: "127.0.0.1",
  maxConnections: Number(process.env.DEV_DB_MAX_CONNECTIONS ?? 1000),
  // Backstop for pipeline affinity: a client that stalls mid-pipeline (Parse
  // sent, no Sync) with its socket still OPEN would hold the queue's handler
  // affinity forever and starve every other connection, since affinity only
  // releases on detach and detach needs close/error/idle-timeout. In ms; the
  // timer resets on every data event, so only a genuinely dead client trips it.
  idleTimeout: Number(process.env.DEV_DB_IDLE_TIMEOUT_MS ?? 30_000),
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
