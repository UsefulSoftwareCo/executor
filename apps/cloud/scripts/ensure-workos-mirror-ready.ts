/* oxlint-disable executor/no-try-catch-or-throw -- boundary: out-of-band deploy gate over a raw postgres connection */
// ---------------------------------------------------------------------------
// Deploy gate: make the membership mirror READY before the build that
// authorizes from it goes live, and fail the deploy if it cannot be.
//
//   bun run db:ensure-workos-mirror-ready:prod   # op run --env-file=.env.production
//   (deploy.yml runs it after the migrations, before the cloud deploy)
//
// Readiness is the SAME rule the request path applies
// (`src/auth/mirror-readiness-store.ts`): the one-off backfill has written
// every organization (`workos_sync.backfill_completed_at`) AND the events
// reconciler has drained the stream within its lag budget
// (`workos_sync.drained_at`). Until both hold the deployed build reads
// membership from WorkOS instead of the mirror, so an unready mirror never
// locks anyone out or lets a revoked member in — but a deploy that leaves it
// unready would run every request through that fallback, which is the state
// this whole cutover exists to leave behind. So this gate:
//   1. reads the readiness row;
//   2. if the backfill has not completed, RUNS it (scripts/backfill-workos-mirror.ts,
//      idempotent) and reads again;
//   3. if the reconciler has not drained recently, DRAINS the stream itself
//      (scripts/drain-workos-events.ts: the same replay the Worker's cron
//      runs, over this connection) and reads again — never merely waits for
//      the cron: this gate runs BEFORE the build that carries the cron may
//      have been deployed, and a gate that only waited could not pass until
//      the reconciler build had shipped on its own, by hand. A cron that is
//      already live is safe beside it (the cursor's compare-and-set gives
//      the stream one owner at a time);
//   4. exits 0 only when the mirror is ready, and 1 with the reason otherwise.
// Needs DATABASE_URL and WORKOS_API_KEY (the backfill and the drain read WorkOS).
// ---------------------------------------------------------------------------

import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { directDatabaseUrl, waitForDatabaseConnection } from "./database-connection";

import {
  MirrorReadinessState,
  describeMirrorReadiness,
  readMirrorReadiness,
} from "../src/auth/mirror-readiness-store";

const __dirname = dirname(fileURLToPath(import.meta.url));
const BACKFILL_SCRIPT = resolve(__dirname, "backfill-workos-mirror.ts");
const DRAIN_SCRIPT = resolve(__dirname, "drain-workos-events.ts");

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  console.error("DATABASE_URL is not set");
  process.exit(1);
}

const usesLocalDatabase =
  connectionString.includes("127.0.0.1") || connectionString.includes("localhost");

const sql = postgres(directDatabaseUrl(connectionString), {
  max: 1,
  prepare: false,
  connect_timeout: 10,
  ...(usesLocalDatabase ? {} : { ssl: "require" as const }),
});
const db = drizzle(sql);

const log = (line: string) => console.log(`[mirror-ready] ${line}`);

const readiness = () => readMirrorReadiness(db, new Date());

// The backfill and drain scripts own their own WorkOS + database wiring;
// running them as subprocesses (with this process's env) keeps that wiring
// in one place.
const runScript = (what: string, script: string) => {
  if (!process.env.WORKOS_API_KEY) {
    throw new Error(`WORKOS_API_KEY is not set; the mirror ${what} cannot run`);
  }
  const result = spawnSync("bun", ["run", script], {
    stdio: "inherit",
    env: process.env,
  });
  if (result.status !== 0) {
    throw new Error(`the mirror ${what} exited with status ${result.status ?? "unknown"}`);
  }
};

try {
  await waitForDatabaseConnection(sql, { log });
  let state = await readiness();
  log(describeMirrorReadiness(state));

  if (MirrorReadinessState.$is("BackfillPending")(state)) {
    log("backfill not completed; running scripts/backfill-workos-mirror.ts");
    runScript("backfill", BACKFILL_SCRIPT);
    state = await readiness();
    log(describeMirrorReadiness(state));
  }

  if (MirrorReadinessState.$is("ReconcilerStale")(state)) {
    log("events stream not drained recently; running scripts/drain-workos-events.ts");
    runScript("drain", DRAIN_SCRIPT);
    state = await readiness();
    log(describeMirrorReadiness(state));
  }

  if (!MirrorReadinessState.$is("Ready")(state)) {
    console.error(
      `[mirror-ready] the membership mirror is not ready: ${describeMirrorReadiness(state)}. ` +
        "The deployed build would read membership from WorkOS on every request until it is. " +
        "Check that WorkOS is reachable and the backfill has run, then rerun the deploy.",
    );
    process.exit(1);
  }
  log("the membership mirror is ready");
} finally {
  await sql.end({ timeout: 5 });
}
