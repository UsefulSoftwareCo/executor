// ---------------------------------------------------------------------------
// Local dev Postgres via PGlite — no Docker, no install
// ---------------------------------------------------------------------------
//
// Exposes an in-process PGlite instance over a TCP socket so Hyperdrive's
// localConnectionString can connect to it like a real Postgres server.
// Runs FumaDB migrations on startup so the schema is ready.

import { execSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { collectTables } from "@executor-js/sdk";
import executorConfig from "../executor.config";
import { ensureCloudSchema } from "../src/services/schema-init";
import { createPgliteFumaDb } from "../src/services/pglite";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = 5433;
const DB_PATH = resolve(__dirname, "../.dev-db");
const CUTOVER_MARKER_PATH = resolve(DB_PATH, "fumadb-cutover-v1");

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

if (existsSync(DB_PATH) && !existsSync(CUTOVER_MARKER_PATH)) {
  console.log("[dev-db] Resetting pre-FumaDB dev database");
  rmSync(DB_PATH, { recursive: true, force: true });
}

console.log(`[dev-db] Starting PGlite at ${DB_PATH}`);
const runtime = await createPgliteFumaDb({
  tables: collectTables(executorConfig.plugins({})),
  namespace: "executor_cloud",
  dataDir: DB_PATH,
  port: PORT,
  host: "127.0.0.1",
});
await ensureCloudSchema(runtime.drizzle);
mkdirSync(DB_PATH, { recursive: true });
writeFileSync(CUTOVER_MARKER_PATH, `${new Date().toISOString()}\n`, { flag: "w" });
console.log(`[dev-db] Listening on postgresql://postgres:postgres@127.0.0.1:${PORT}/postgres`);

const shutdown = async () => {
  console.log("\n[dev-db] Shutting down");
  await runtime.close();
  process.exit(0);
};

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
