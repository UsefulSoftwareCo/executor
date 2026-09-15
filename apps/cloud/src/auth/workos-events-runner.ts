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
// ---------------------------------------------------------------------------

import { Effect, Layer } from "effect";

import { captureCauseEffect } from "../observability";
import { WorkerTelemetryLive } from "../observability/telemetry";
import { makeDbLayer } from "../db/db";
import { makeUserStoreLayer } from "./context";
import { CoreSharedServices } from "./workos";
import { syncWorkOsEvents } from "./workos-events-sync";
import { makeWorkOsMirrorLayer } from "./workos-mirror";

const makeSyncServices = () => {
  const dbLive = makeDbLayer();
  return Layer.mergeAll(
    makeUserStoreLayer().pipe(Layer.provide(dbLive)),
    makeWorkOsMirrorLayer().pipe(Layer.provide(dbLive)),
    CoreSharedServices,
  );
};

/**
 * One reconciler pass over fresh request-scoped services. Resolves when the
 * pass ends, whether it drained the stream, stopped at the page budget,
 * yielded to another run, or failed (a failure is reported, never thrown).
 */
export const runWorkOsEventsSync = (): Promise<void> =>
  Effect.runPromise(
    syncWorkOsEvents().pipe(
      Effect.asVoid,
      Effect.provide(makeSyncServices()),
      Effect.scoped,
      Effect.catchCause((cause) =>
        Effect.gen(function* () {
          yield* Effect.logError("workos_events: sync run failed", cause);
          yield* captureCauseEffect(cause);
        }),
      ),
      Effect.provide(WorkerTelemetryLive),
    ),
  );
