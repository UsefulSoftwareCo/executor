// ---------------------------------------------------------------------------
// Runs one reconciler pass (`syncWorkOsEvents`) from a Worker entry that is
// not an HTTP request handled by the Effect app: the every-minute cron
// (`scheduled` in server.ts) and the webhook poke (`workos-webhook.ts`,
// detached past the response with `waitUntil`).
//
// Both entries build the request-scoped services FRESH for the run — the
// same reason `mcp/auth.ts` does: a postgres socket belongs to one Workers
// invocation, and the webhook route's own per-request layer is closed the
// moment its response is returned, so a detached run cannot borrow it. The
// run is its own scope; the socket is released when it ends.
//
// A failing run is captured (Sentry + structured log) and swallowed here:
// neither entry has a caller to report to, and the run is retried by the
// next cron tick from the last committed cursor.
//
// A run that does not fail outright can still leave the mirror stale: one
// that stops short of `"drained"` (page budget, cursor contention) means the
// reconciler did not catch up this tick, and one stuck on
// `"awaiting_backfill"` past the budget means the boundary row the backfill
// was supposed to hand off was lost — both are read from `drainedAt` after
// the run and, past `MIRROR_RECONCILER_LAG_BUDGET`, reported the same way a
// thrown failure is: a structured error log plus a Sentry capture. This is
// the ONLY place a stale reconciler surfaces now; the request path
// (`auth/organization.ts`) no longer checks readiness or falls back.
// ---------------------------------------------------------------------------

import { Clock, Data, Duration, Effect, Layer } from "effect";

import { captureCauseEffect } from "../observability";
import { WorkerTelemetryLive } from "../observability/telemetry";
import { makeDbLayer } from "../db/db";
import { makeUserStoreLayer } from "./context";
import { MIRROR_RECONCILER_LAG_BUDGET } from "./mirror-readiness-store";
import { CoreSharedServices } from "./workos";
import { syncWorkOsEvents, type WorkOsEventsSyncReport } from "./workos-events-sync";
import { makeWorkOsMirrorLayer, WorkOsMirror } from "./workos-mirror";

const makeSyncServices = () => {
  const dbLive = makeDbLayer();
  return Layer.mergeAll(
    makeUserStoreLayer().pipe(Layer.provide(dbLive)),
    makeWorkOsMirrorLayer().pipe(Layer.provide(dbLive)),
    CoreSharedServices,
  );
};

const LAG_BUDGET_MS = Duration.toMillis(MIRROR_RECONCILER_LAG_BUDGET);

/**
 * The mirror has not drained the WorkOS events stream inside its lag budget.
 * Its own tagged error so Sentry groups every occurrence under one issue,
 * with the run's outcome and the heartbeat's age as the fields to read.
 */
export class WorkOsReconcilerStale extends Data.TaggedError("WorkOsReconcilerStale")<{
  readonly stopped: WorkOsEventsSyncReport["stopped"];
  readonly drainedAt: string | null;
  readonly ageMs: number | null;
}> {}

/**
 * After a run that did not end `"drained"`, check whether the mirror has
 * fallen behind its lag budget and, if so, report it the way a failed run is
 * reported: a structured error log plus a Sentry capture. A run ending
 * `"drained"` just wrote `markDrained` and is healthy by definition, so it is
 * never checked. Cheap by design: one `drainedAt` read per run (about once a
 * minute).
 */
export const alertOnStaleReconciler = Effect.fn("workos_events.alert_on_stale_reconciler")(
  function* (report: WorkOsEventsSyncReport) {
    if (report.stopped === "drained") return;

    const mirror = yield* WorkOsMirror;
    const drainedAt = yield* mirror.drainedAt();
    const now = yield* Clock.currentTimeMillis;
    const ageMs = drainedAt === null ? null : now - drainedAt.getTime();
    if (ageMs !== null && ageMs <= LAG_BUDGET_MS) return;

    const stale = new WorkOsReconcilerStale({
      stopped: report.stopped,
      drainedAt: drainedAt === null ? null : drainedAt.toISOString(),
      ageMs,
    });
    yield* Effect.logError("workos_events: reconciler stale", stale);
    yield* captureCauseEffect(stale);
  },
);

/**
 * One reconciler pass over fresh request-scoped services. Resolves when the
 * pass ends, whether it drained the stream, stopped at the page budget,
 * yielded to another run, or failed (a failure is reported, never thrown).
 * A run that ends short of `"drained"` and leaves `drainedAt` past the lag
 * budget is ALSO reported (see {@link alertOnStaleReconciler}) — a stalled
 * reconciler is now an operational alert, not a per-request fallback.
 */
export const runWorkOsEventsSync = (): Promise<void> =>
  Effect.runPromise(
    syncWorkOsEvents().pipe(
      Effect.tap((report) => alertOnStaleReconciler(report)),
      Effect.asVoid,
      Effect.provide(makeSyncServices()),
      Effect.scoped,
      Effect.catchCause((cause) =>
        Effect.gen(function* () {
          yield* Effect.logError("workos_events: sync run failed");
          yield* captureCauseEffect(cause);
        }),
      ),
      Effect.provide(WorkerTelemetryLive),
    ),
  );
