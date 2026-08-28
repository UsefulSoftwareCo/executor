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
import postgres from "postgres";

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
// affinity while a pipeline is open. The patch also fixes the queue's two
// self-bricking failure paths — both surfaced in CI as the e2e "cloud signIn:
// callback set no session (500)" cascade, where new connections' startup
// packets sat unanswered (postgres.js CONNECT_TIMEOUT) until restart:
//   1. Stock 0.1.4 `return`ed out of the drain loop when a query REJECTED at
//      the JS level, leaving its `processing` flag latched true; nothing was
//      ever dequeued again.
//   2. A client whose socket died WHILE its pipeline-opening entry executed:
//      detach() cleared affinity before the entry finished, the queue then
//      took affinity for the already-dead handler, and no timer was left to
//      release it. The queue now tracks detached handlers and repairs any
//      transaction or pipeline affinity they can no longer release.
// src/db/dev-db-socket-concurrency.node.test.ts is the regression test for
// all of the above.
const makeServer = () =>
  new PGLiteSocketServer({
    db,
    port: PORT,
    host: "127.0.0.1",
    maxConnections: Number(process.env.DEV_DB_MAX_CONNECTIONS ?? 1000),
    // Backstop for pipeline affinity: a client that stalls mid-pipeline (Parse
    // sent, no Sync) with its socket still OPEN would hold the queue's handler
    // affinity forever and starve every other connection, since affinity only
    // releases on detach and detach needs close/error/idle-timeout. In ms; the
    // timer resets on every data event. The patch scopes the reap to connections
    // actually HOLDING affinity (open pipeline or transaction): an idle-at-rest
    // connection is the normal state of a healthy postgres.js pool held by a
    // long-lived scope (SSE), and reaping those raced live queries into
    // sporadic `write CONNECTION_ENDED` 500s.
    idleTimeout: Number(process.env.DEV_DB_IDLE_TIMEOUT_MS ?? 30_000),
  });

let server = makeServer();
await server.start();
console.log(`[dev-db] Listening on postgresql://postgres:postgres@127.0.0.1:${PORT}/postgres`);

let stopping = false;

const shutdown = async () => {
  stopping = true;
  console.log("\n[dev-db] Shutting down");
  await server.stop();
  await db.close();
  process.exit(0);
};

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

// ---------------------------------------------------------------------------
// Wedge watchdog
// ---------------------------------------------------------------------------
//
// Twice the socket server has shipped a state machine that could stop
// answering NEW connections while the process, the port, and PGlite all stayed
// up (the CI e2e "cloud signIn: callback set no session (500)" cascades: every
// in-flight query dies once, then every fresh connection's startup packet
// times out — CONNECT_TIMEOUT — for the rest of the shard). The known paths
// are patched with regression tests, but each recurrence so far has found a
// new path, and a wedged front-end turns ONE infra hiccup into a failure of
// every remaining test in the shard.
//
// So: probe the server the way the app does — a fresh TCP connection, real
// startup handshake, `select 1` — and when several consecutive probes fail,
// dump the server's internals to the boot log and swap in a fresh socket
// server on the same PGlite instance (all state is in PGlite; the front-end is
// stateless, so this drops only already-doomed connections). If a restart
// doesn't restore service, exit non-zero: the boot supervisor logs the exit
// loudly and the run fails fast with an attributable cause instead of minutes
// of anonymous CONNECT_TIMEOUTs. The wedge itself stays visible in the
// server-logs artifact via the [dev-db][watchdog] lines.
const WATCHDOG_INTERVAL_MS = Number(process.env.DEV_DB_WATCHDOG_INTERVAL_MS ?? 5_000);
// 3 consecutive failures ≈ 15s+ of hard unavailability. PGlite serves queries
// in milliseconds; even a deep queue clears in well under one probe interval,
// so consecutive startup failures this sustained only happen wedged.
const WATCHDOG_FAILURES_TO_RESTART = 3;
const WATCHDOG_MAX_RESTARTS = 3;

const probe = async (): Promise<void> => {
  const sql = postgres(`postgres://postgres:postgres@127.0.0.1:${PORT}/postgres`, {
    max: 1,
    idle_timeout: 0,
    connect_timeout: 5,
    fetch_types: false,
    prepare: false,
    onnotice: () => undefined,
  });
  try {
    // connect_timeout only bounds the handshake; race the query too so a
    // post-startup wedge cannot hang the watchdog itself.
    await Promise.race([
      sql.unsafe("select 1"),
      sleep(10_000).then(() => {
        throw new Error("probe query timed out after 10s");
      }),
    ]);
  } finally {
    await sql.end({ timeout: 5 }).catch(() => {});
  }
};

const watchdog = async () => {
  let consecutiveFailures = 0;
  let restarts = 0;
  for (;;) {
    await sleep(WATCHDOG_INTERVAL_MS);
    if (stopping) return;
    try {
      await probe();
      consecutiveFailures = 0;
    } catch (cause) {
      consecutiveFailures += 1;
      console.error(
        `[dev-db][watchdog] probe failed (${consecutiveFailures}/${WATCHDOG_FAILURES_TO_RESTART}): ${String(cause)}`,
      );
      if (consecutiveFailures < WATCHDOG_FAILURES_TO_RESTART) continue;
      console.error(
        `[dev-db][watchdog] socket server wedged; stats: ${JSON.stringify(server.getStats())}`,
      );
      if (restarts >= WATCHDOG_MAX_RESTARTS) {
        console.error(
          `[dev-db][watchdog] still wedged after ${restarts} restarts — giving up so the boot supervisor reports it`,
        );
        process.exit(1);
      }
      restarts += 1;
      consecutiveFailures = 0;
      console.error(
        `[dev-db][watchdog] restarting socket server (${restarts}/${WATCHDOG_MAX_RESTARTS})`,
      );
      // stop() itself goes through the query queue (detach rolls back open
      // transactions), so a wedge deep enough can hang the restart too —
      // bound it and treat that as fatal rather than hanging the watchdog.
      const restart = async () => {
        await server.stop();
        server = makeServer();
        await server.start();
      };
      try {
        await Promise.race([
          restart(),
          sleep(15_000).then(() => {
            throw new Error("restart timed out after 15s");
          }),
        ]);
        console.error(`[dev-db][watchdog] socket server restarted`);
      } catch (restartCause) {
        console.error(
          `[dev-db][watchdog] restart failed (${String(restartCause)}) — exiting so the boot supervisor reports it`,
        );
        process.exit(1);
      }
    }
  }
};

void watchdog();
